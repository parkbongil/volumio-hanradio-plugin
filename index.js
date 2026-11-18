'use strict';

/**
 * Han Radio Plugin v1.0.3
 * Korean Internet Radio - KBS Classic FM, KBS Cool FM & CBS Music FM
 * Volumio Standard Pattern (function/prototype)
 */

const libQ = require('kew');
const https = require('https');
const http = require('http');

const SERVICE_NAME = 'hanradio';

module.exports = ControllerHanRadio;

function ControllerHanRadio(context) {
    const self = this;

    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.configManager = self.context.configManager;

    self.serviceName = SERVICE_NAME;

    self.currentUri = null;
    self.currentChannel = null;
    self.isPlaying = false;

    self.scheduleTimer = null;
    self.probeTimer = null;
    self.watchdogTimer = null;

    // every start of a channel gets the next number: work for an older start (a slow stream API answer
    // arriving after another channel was chosen) sees its number is no longer the current one and stops
    self.playGen = 0;
    self.playStartedAt = 0;
    self.reconnects = [];   // when the watchdog restarted the stream, to keep it from retrying forever

    // Audio info detected from stream
    self.audioInfo = {
        samplerate: '',
        bitdepth: '',
        bitrate: '',
        channels: 2
    };

    self.channels = {
        'kbs-classic-fm': {
            name: 'KBS Classic FM',
            streamApiUrl: 'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/24',
            scheduleUrl: 'https://static.api.kbs.co.kr/mediafactory/v1/schedule/weekly?local_station_code=00&channel_code=24',
            defaultAlbumart: '/albumart?sourceicon=music_service/hanradio/images/kbs-classic-fm.png',
            albumart: null,
            programTitle: '',
            programActor: ''
        },
        'kbs-cool-fm': {
            name: 'KBS Cool FM',
            streamApiUrl: 'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/25',
            scheduleUrl: 'https://static.api.kbs.co.kr/mediafactory/v1/schedule/weekly?local_station_code=00&channel_code=25',
            defaultAlbumart: '/albumart?sourceicon=music_service/hanradio/images/kbs-cool-fm.png',
            albumart: null,
            programTitle: '',
            programActor: ''
        },
        'cbs-music-fm': {
            name: 'CBS Music FM',
            streamUrl: 'https://m-aac.cbs.co.kr/busan981/_definst_/busan981.stream/playlist.m3u8',
            scheduleUrl: 'https://www.cbs.co.kr/schedule/musicfm/ajax',
            defaultAlbumart: '/albumart?sourceicon=music_service/hanradio/images/cbs-music-fm.png',
            albumart: null,
            programTitle: '',
            programActor: ''
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// VOLUMIO LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.onVolumioStart = function() {
    const self = this;
    return libQ.resolve();
};

ControllerHanRadio.prototype.onStart = function() {
    const self = this;
    const defer = libQ.defer();

    self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
    self.addToBrowseSources();
    self.startScheduleTimer();
    self.logger.info('[HanRadio] Plugin started');

    defer.resolve();
    return defer.promise;
};

ControllerHanRadio.prototype.onStop = function() {
    const self = this;
    const defer = libQ.defer();

    self.stopScheduleTimer();
    self.stopWatchdog();
    if (self.probeTimer) {
        clearTimeout(self.probeTimer);
        self.probeTimer = null;
    }
    self.removeFromBrowseSources();
    self.logger.info('[HanRadio] Plugin stopped');

    defer.resolve();
    return defer.promise;
};

ControllerHanRadio.prototype.onRestart = function() {
    const self = this;
    return libQ.resolve();
};

ControllerHanRadio.prototype.getConfigurationFiles = function() {
    return [];
};

// ═══════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const HTTP_TIMEOUT_MS = 8000;       // an API that does not answer must not hold playback at "Connecting..."
const STREAM_API_TRIES = 3;         // the KBS live API is slow at times (seconds): asked up to three times
const STREAM_API_TIMEOUT_MS = 12000;
const BROWSE_WAIT_MS = 2500;        // the channel list waits this long for the schedules, then shows the logos
const SCHEDULE_MAX_AGE_MS = 30 * 60 * 1000;   // a day's schedule is asked again after this long
const SCHEDULE_RETRY_MS = 5 * 60 * 1000;      // after a failed schedule request, the next one waits this long
const SHORT_ITEM_MIN = 5;           // campaigns and jingles shorter than this keep the programme around them

// GET with the body read as bytes and decoded once (a Korean character split across two chunks stays whole),
// a timeout, and up to three redirects
ControllerHanRadio.prototype.httpRequest = function(requestUrl, redirects, timeoutMs) {
    const self = this;
    const limit = timeoutMs || HTTP_TIMEOUT_MS;
    const defer = libQ.defer();
    let done = false;
    // kew's resolve and reject need their promise as `this`: never pass them around unbound
    const finish = function(fn, value) { if (!done) { done = true; if (fn === defer.resolve) { defer.resolve(value); } else { defer.reject(value); } } };
    const protocol = requestUrl.indexOf('https') === 0 ? https : http;

    const req = protocol.get(requestUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Volumio; HanRadio)' } }, function(response) {
        const code = response.statusCode;
        if (code >= 300 && code < 400 && response.headers.location && (redirects || 0) < 3) {
            response.resume();
            let next = response.headers.location;
            if (next.indexOf('http') !== 0) { next = new URL(next, requestUrl).toString(); }
            self.httpRequest(next, (redirects || 0) + 1, limit).then(function(body) { finish(defer.resolve, body); }).fail(function(err) { finish(defer.reject, err); });
            return;
        }
        const chunks = [];
        response.on('data', function(chunk) { chunks.push(chunk); });
        response.on('end', function() {
            if (code === 200) {
                finish(defer.resolve, Buffer.concat(chunks).toString('utf8'));
            } else {
                self.logger.error('[HanRadio] HTTP error: ' + code + ' ' + requestUrl);
                finish(defer.reject, new Error('HTTP ' + code));
            }
        });
        response.on('error', function(err) { finish(defer.reject, err); });
    });
    req.setTimeout(limit, function() { req.destroy(new Error('timeout after ' + limit + ' ms')); });
    req.on('error', function(err) {
        self.logger.error('[HanRadio] HTTP request error: ' + err.message + ' ' + requestUrl);
        finish(defer.reject, err);
    });

    return defer.promise;
};

ControllerHanRadio.prototype.httpGet = function(requestUrl, timeoutMs) {
    const self = this;
    return self.httpRequest(requestUrl, 0, timeoutMs).then(function(text) {
        try {
            return JSON.parse(text);
        } catch (e) {
            self.logger.error('[HanRadio] JSON parse error: ' + e.message);
            throw e;
        }
    });
};

ControllerHanRadio.prototype.httpGetText = function(requestUrl) {
    return this.httpRequest(requestUrl);
};

// resolves with the promise's value, or with null once `ms` have passed or when it fails
ControllerHanRadio.prototype.within = function(promise, ms) {
    const defer = libQ.defer();
    let done = false;
    const timer = setTimeout(function() { if (!done) { done = true; defer.resolve(null); } }, ms);
    promise.then(function(value) {
        if (!done) { done = true; clearTimeout(timer); defer.resolve(value); }
    }).fail(function() {
        if (!done) { done = true; clearTimeout(timer); defer.resolve(null); }
    });
    return defer.promise;
};

// ═══════════════════════════════════════════════════════════════════════════
// STREAM URL
// ═══════════════════════════════════════════════════════════════════════════

// When the KBS URL stops working. Its signed address carries its own expiry (CloudFront's Policy:
// DateLessThan AWS:EpochTime); 0 when it cannot be read.
function signedUrlExpiry(url) {
    const m = /[?&]Policy=([^&]+)/.exec(url || '');
    if (!m) { return 0; }
    try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
        const policy = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        const t = policy.Statement[0].Condition.DateLessThan['AWS:EpochTime'];
        return t ? t * 1000 : 0;
    } catch (e) {
        return 0;
    }
}

// KBS Classic FM / Cool FM: the stream's signed address, from the live API. The API answers in well under a
// second most of the time but takes several seconds at others (a Cool FM press timed out twice in a row), so
// it is asked up to STREAM_API_TRIES times; when every try fails, the last address it gave is used while its
// signature is still valid.
ControllerHanRadio.prototype.getStreamUrl = function(channelKey) {
    const self = this;
    const channel = self.channels[channelKey];

    if (!channel) {
        return libQ.reject(new Error('Unknown channel: ' + channelKey));
    }
    if (channelKey === 'cbs-music-fm') {
        return libQ.resolve(channel.streamUrl);
    }

    const ask = function(attempt) {
        return self.httpGet(channel.streamApiUrl, STREAM_API_TIMEOUT_MS)
            .then(function(data) {
                // API response contains channel_item array with service_url
                const channelItems = data && data.channel_item;
                if (Array.isArray(channelItems) && channelItems.length > 0 && channelItems[0].service_url) {
                    return channelItems[0].service_url;
                }
                self.logger.error('[HanRadio] No service_url found in KBS API response: ' + JSON.stringify(data).substring(0, 300));
                throw new Error('No stream URL found');
            })
            .fail(function(err) {
                if (attempt < STREAM_API_TRIES) {
                    self.logger.warn('[HanRadio] KBS stream API try ' + attempt + ' failed (' + err.message + '), trying again');
                    return ask(attempt + 1);
                }
                throw err;
            });
    };

    return ask(1)
        .then(function(url) {
            channel.lastStreamUrl = url;
            channel.lastStreamUrlExpires = signedUrlExpiry(url);
            self.logger.info('[HanRadio] KBS stream URL: ' + url);
            return url;
        })
        .fail(function(err) {
            const expires = channel.lastStreamUrlExpires || 0;
            if (channel.lastStreamUrl && expires - Date.now() > 60 * 1000) {
                self.logger.warn('[HanRadio] KBS stream API failed (' + err.message + '): using the last address, valid until ' + new Date(expires).toISOString());
                return channel.lastStreamUrl;
            }
            self.logger.error('[HanRadio] Failed to get KBS stream URL: ' + err.message);
            throw err;
        });
};

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE
//
// Every channel's schedule is kept as a list of { start, end, title, actor, image } in minutes of its day,
// cached per day, so the channel list and the player ask the API at most once per day and half hour.
//
// KBS counts a broadcast day from 05:00 to 29:00 (05:00 the next morning): at 02:00 the programme on air is
// in the previous date's schedule, at 26:00. CBS counts the calendar day (00:00–23:59).
// Times are Korean time (UTC+9) whatever the player's own time zone.
// ═══════════════════════════════════════════════════════════════════════════

function kstNow() {
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return { date: d, hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

function ymd(d) {
    const m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + (m < 10 ? '0' : '') + m + (day < 10 ? '0' : '') + day;
}

// "HHMM…" (KBS, hours may pass 24) or "HH:MM" (CBS) → minutes
function toMinutes(t) {
    t = String(t || '');
    const parts = t.indexOf(':') >= 0 ? t.split(':') : [t.substring(0, 2), t.substring(2, 4)];
    const h = parseInt(parts[0], 10), m = parseInt(parts[1] || '0', 10);
    if (isNaN(h)) { return NaN; }
    return h * 60 + (isNaN(m) ? 0 : m);
}

// the day a channel's schedule is read from, and the minute of that day it is now
ControllerHanRadio.prototype.scheduleClock = function(channelKey) {
    const now = kstNow();
    const minute = now.hour * 60 + now.minute;
    if (channelKey === 'cbs-music-fm') {
        return { day: ymd(now.date), minute: minute };
    }
    if (now.hour < 5) {   // KBS: still the previous broadcast day
        return { day: ymd(new Date(now.date.getTime() - 24 * 3600 * 1000)), minute: minute + 24 * 60 };
    }
    return { day: ymd(now.date), minute: minute };
};

ControllerHanRadio.prototype.normalizeKbs = function(data, day) {
    const days = Array.isArray(data) ? data : [data];
    const found = days.filter(function(d) { return d && d.program_planned_date === day; })[0] || days[0] || {};
    const list = Array.isArray(found.schedules) ? found.schedules : [];
    return list.map(function(item) {
        return {
            start: toMinutes(item.program_planned_start_time),
            end: toMinutes(item.program_planned_end_time),
            // programming_table_title leaves out the sponsor's tag ("… 제작협찬") program_title carries
            title: item.programming_table_title || item.program_title || '',
            actor: item.program_actor || '',
            image: item.image_w || ''
        };
    }).filter(function(p) { return !isNaN(p.start) && !isNaN(p.end); });
};

ControllerHanRadio.prototype.normalizeCbs = function(data) {
    // API returns object with numeric keys {"0":{}, "1":{}, ...}, not an array
    let list = [];
    if (Array.isArray(data)) {
        list = data;
    } else if (typeof data === 'object' && data !== null) {
        Object.keys(data).forEach(function(k) { if (data[k] && data[k].startTime) { list.push(data[k]); } });
    }
    return list.map(function(item) {
        let end = toMinutes(item.endTime);
        if (end === 23 * 60 + 59) { end = 24 * 60; }   // the last programme ends at 23:59, the day at 24:00
        let image = (item.program && item.program.image && item.program.image.mobileTop) || '';
        if (image && image.indexOf('http') !== 0) { image = 'https://cbs.co.kr' + image; }
        return {
            start: toMinutes(item.startTime),
            end: end,
            title: item.name || '',
            // mc is in item.program.mc, top-level mc is empty
            actor: (item.program && item.program.mc) || item.mc || '',
            image: image
        };
    }).filter(function(p) { return !isNaN(p.start) && !isNaN(p.end); });
};

// the channel's schedule for a day, from the cache while it is fresh
ControllerHanRadio.prototype.loadSchedule = function(channelKey, day) {
    const self = this;
    const channel = self.channels[channelKey];
    self.scheduleCache = self.scheduleCache || {};
    const cached = self.scheduleCache[channelKey];
    if (cached && cached.day === day && Date.now() - cached.at < SCHEDULE_MAX_AGE_MS) {
        return libQ.resolve(cached.items);
    }
    if (cached && cached.day === day && cached.pending) { return cached.pending; }
    // after a failure the API is left alone for SCHEDULE_RETRY_MS: the minute check does not knock every minute
    if (cached && cached.day === day && cached.retryAt && Date.now() < cached.retryAt) {
        return cached.items ? libQ.resolve(cached.items) : libQ.reject(cached.error || new Error('schedule unavailable'));
    }

    let url = channel.scheduleUrl;
    if (channelKey !== 'cbs-music-fm') {
        url += '&program_planned_date_from=' + day + '&program_planned_date_to=' + day;
    }
    const pending = self.httpGet(url).then(function(data) {
        const items = channelKey === 'cbs-music-fm' ? self.normalizeCbs(data) : self.normalizeKbs(data, day);
        self.scheduleCache[channelKey] = { day: day, at: Date.now(), items: items };
        return items;
    }).fail(function(err) {
        // a failed refresh keeps the older copy of the same day rather than nothing, and waits before asking again
        const retryAt = Date.now() + SCHEDULE_RETRY_MS;
        if (cached && cached.day === day && cached.items) {
            self.scheduleCache[channelKey] = { day: day, at: cached.at, items: cached.items, retryAt: retryAt };
            return cached.items;
        }
        self.scheduleCache[channelKey] = { day: day, at: 0, items: null, retryAt: retryAt, error: err };
        throw err;
    });
    self.scheduleCache[channelKey] = { day: day, at: cached ? cached.at : 0, items: cached && cached.day === day ? cached.items : null, pending: pending };
    return pending;
};

// the programme on air now: { title, actor, image, endsInMin } or null
ControllerHanRadio.prototype.getNowProgram = function(channelKey) {
    const self = this;
    if (!self.channels[channelKey]) { return libQ.reject(new Error('Unknown channel')); }
    const clock = self.scheduleClock(channelKey);
    return self.loadSchedule(channelKey, clock.day).then(function(items) {
        const at = clock.minute;
        let onAir = items.filter(function(p) { return at >= p.start && at < p.end; })[0] || null;
        // a one-minute campaign between two halves of a show: show the show
        if (onAir && onAir.end - onAir.start < SHORT_ITEM_MIN) {
            const around = items.filter(function(p) { return p.end - p.start >= SHORT_ITEM_MIN && p.start <= at; }).pop();
            if (around) { onAir = { start: around.start, end: onAir.end, title: around.title, actor: around.actor, image: around.image }; }
        }
        if (!onAir) { return null; }
        return { title: onAir.title, actor: onAir.actor, image: onAir.image, endsInMin: onAir.end - at };
    });
};

// sets the channel's programme title, host and picture for the player (the logo and the channel name when nothing is known)
ControllerHanRadio.prototype.fetchSchedule = function(channelKey) {
    const self = this;
    const channel = self.channels[channelKey];
    if (!channel) { return libQ.reject(new Error('Unknown channel')); }

    // asked once a minute while playing: the log says only what changed (a new programme, a failure, a recovery)
    const before = [channel.programTitle, channel.programActor].join(' / ');
    return self.getNowProgram(channelKey)
        .then(function(p) {
            channel.programTitle = (p && p.title) || channel.name;
            channel.programActor = (p && p.actor) || '';
            channel.albumart = (p && p.image) || channel.defaultAlbumart;
            const after = [channel.programTitle, channel.programActor].join(' / ');
            if (after !== before || channel.scheduleFailing) {
                self.logger.info('[HanRadio] Schedule ' + channelKey + ': ' + after + (channel.scheduleFailing ? ' (schedule readable again)' : ''));
            }
            channel.scheduleFailing = false;
        })
        .fail(function(err) {
            if (!channel.scheduleFailing) {
                self.logger.error('[HanRadio] Schedule fetch failed for ' + channelKey + ': ' + err.message);
            }
            channel.scheduleFailing = true;
            throw err;
        });
};

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE TIMER: once a minute while playing, the programme on air is looked up again
// (from the cache): the player follows a programme that starts at 21:40 as well as one at 22:00
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.startScheduleTimer = function() {
    const self = this;
    self.stopScheduleTimer();
    self.scheduleTimer = setInterval(function() { self.updateCurrentSchedule(); }, 60 * 1000);
};

ControllerHanRadio.prototype.stopScheduleTimer = function() {
    const self = this;
    if (self.scheduleTimer) {
        clearInterval(self.scheduleTimer);
        self.scheduleTimer = null;
    }
};

ControllerHanRadio.prototype.updateCurrentSchedule = function() {
    const self = this;

    if (!self.isPlaying || !self.currentChannel) {
        return;
    }
    const channelKey = self.currentChannel;
    const channel = self.channels[channelKey];
    const before = [channel.programTitle, channel.programActor, channel.albumart].join('|');

    self.fetchSchedule(channelKey)
        .then(function() {
            const after = [channel.programTitle, channel.programActor, channel.albumart].join('|');
            if (after !== before && self.isPlaying && self.currentChannel === channelKey) {
                self.logger.info('[HanRadio] Programme changed on ' + channelKey);
                self.pushCurrentState();
            }
        })
        .fail(function() {
            // fetchSchedule has logged the first failure; the minutes after it stay quiet until it recovers
        });
};

// ═══════════════════════════════════════════════════════════════════════════
// AUDIO PROBE (detect samplerate/bitrate from MPD after 3 seconds)
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.probeStreamAudioInfo = function() {
    const self = this;

    if (self.probeTimer) {
        clearTimeout(self.probeTimer);
        self.probeTimer = null;
    }

    self.probeTimer = setTimeout(function() {
        self.probeTimer = null;

        if (!self.isPlaying) return;

        // CBS Music FM: parse m3u8 for bitrate, then probe MPD for samplerate/bitdepth
        let bitratePromise;
        if (self.currentChannel === 'cbs-music-fm') {
            const channel = self.channels['cbs-music-fm'];
            bitratePromise = self.parseM3u8Bitrate(channel.streamUrl);
        } else {
            bitratePromise = libQ.resolve();
        }

        // an HLS stream can take more than 3 seconds to start decoding: ask MPD again, up to 5 times
        const askMpd = function(attempt) {
            return self.mpdPlugin.sendMpdCommand('status', []).then(function(mpdStatus) {
                if (!self.findMpdField(mpdStatus, 'audio') && attempt < 5 && self.isPlaying) {
                    const d = libQ.defer();
                    self.probeTimer = setTimeout(function() { self.probeTimer = null; d.resolve(); }, 2000);
                    return d.promise.then(function() { return self.isPlaying ? askMpd(attempt + 1) : null; });
                }
                return mpdStatus;
            });
        };

        bitratePromise
            .then(function() {
                return askMpd(1);
            })
            .then(function(mpdStatus) {
                if (!mpdStatus || !self.isPlaying) { return; }
                self.parseMpdAudioInfo(mpdStatus);
                self.pushCurrentState();
            })
            .fail(function(err) {
                self.logger.error('[HanRadio] Audio probe failed: ' + err.message);
            });
    }, 3000);
};

ControllerHanRadio.prototype.parseM3u8Bitrate = function(m3u8Url) {
    const self = this;
    const defer = libQ.defer();

    self.httpGetText(m3u8Url)
        .then(function(text) {
            // Parse BANDWIDTH or AVERAGE-BANDWIDTH from #EXT-X-STREAM-INF line
            let match = text.match(/AVERAGE-BANDWIDTH=(\d+)/);
            if (!match) {
                match = text.match(/BANDWIDTH=(\d+)/);
            }
            if (match) {
                const bps = parseInt(match[1], 10);
                const kbps = Math.round(bps / 1000);
                self.audioInfo.bitrate = kbps + ' kbps';
                self.logger.info('[HanRadio] m3u8 bitrate: ' + self.audioInfo.bitrate);
            }
            defer.resolve();
        })
        .fail(function(err) {
            self.logger.error('[HanRadio] m3u8 parse failed: ' + err.message);
            defer.resolve(); // resolve anyway to continue with MPD probe
        });

    return defer.promise;
};

ControllerHanRadio.prototype.parseMpdAudioInfo = function(mpdStatus) {
    const self = this;

    // MPD status 'audio' field format: "samplerate:bits:channels" e.g. "44100:24:2"
    const audio = self.findMpdField(mpdStatus, 'audio');
    const bitrate = self.findMpdField(mpdStatus, 'bitrate');

    if (audio) {
        const parts = audio.split(':');
        if (parts.length >= 3) {
            const sr = parseInt(parts[0], 10);
            const bits = parseInt(parts[1], 10);
            const ch = parseInt(parts[2], 10);

            if (sr > 0) {
                if (sr >= 1000) {
                    self.audioInfo.samplerate = (sr / 1000) + ' kHz';
                } else {
                    self.audioInfo.samplerate = sr + ' Hz';
                }
            }
            if (bits > 0) {
                self.audioInfo.bitdepth = bits + ' bit';
            }
            if (ch > 0) {
                self.audioInfo.channels = ch;
            }
        }
    }

    if (bitrate) {
        const br = parseInt(bitrate, 10);
        if (br > 0) {
            self.audioInfo.bitrate = br + ' kbps';
        }
    }

    // Volumio Player State에서 bitrate 항목은 없어서 bitdepth에 bitrate 같이 표시함
    // (비트 깊이가 없으면 bitrate만, 둘 다 있으면 한 칸 띄워 "24 bit 192 kbps")
    const depthParts = [self.audioInfo.bitdepth, self.audioInfo.bitrate].filter(function(v) { return v; });
    self.audioInfo.bitdepth = depthParts.join(' ');
    self.audioInfo.samplerate = (self.audioInfo.samplerate || '').trim();


    self.logger.info('[HanRadio] Audio info: ' + self.audioInfo.samplerate +
        ' / ' + self.audioInfo.bitdepth +
        ' / ' + self.audioInfo.bitrate +
        ' / ' + self.audioInfo.channels + 'ch');
};

ControllerHanRadio.prototype.findMpdField = function(mpdResult, field) {
    if (!mpdResult) return null;

    // mpdResult can be an object or string
    if (typeof mpdResult === 'object') {
        if (mpdResult[field] !== undefined) return String(mpdResult[field]);
        // Some MPD responses have nested values
        if (mpdResult.values && mpdResult.values[field] !== undefined) {
            return String(mpdResult.values[field]);
        }
    }

    if (typeof mpdResult === 'string') {
        const lines = mpdResult.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.indexOf(field + ':') === 0 || line.indexOf(field + ': ') === 0) {
                return line.substring(line.indexOf(':') + 1).trim();
            }
        }
    }

    return null;
};

// ═══════════════════════════════════════════════════════════════════════════
// PLAYBACK CONTROL
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.clearAddPlayTrack = function(track, reconnecting) {
    const self = this;
    const defer = libQ.defer();

    const channelKey = self.getChannelFromUri(track.uri);
    const gen = ++self.playGen;
    const current = function() { return gen === self.playGen; };
    self.currentChannel = channelKey;
    self.currentUri = track.uri;
    self.isPlaying = true;
    self.playStartedAt = Date.now();
    if (!reconnecting) { self.reconnects = []; }   // a channel chosen by hand starts a fresh retry budget

    // Reset audio info for new stream
    self.audioInfo = { samplerate: '', bitdepth: '', bitrate: '', channels: 2 };

    const channel = self.channels[channelKey];
    if (!channel) {
        defer.reject('Unknown channel');
        return defer.promise;
    }

    // Push initial connecting state
    self.commandRouter.servicePushState({
        status: 'play',
        service: SERVICE_NAME,
        type: 'webradio',
        trackType: 'webradio',
        title: 'Connecting...',
        artist: channel.name,
        album: '',
        albumart: channel.defaultAlbumart,
        uri: track.uri,
        streaming: true,
        disableUiControls: true,
        duration: 0,
        seek: 0
    }, SERVICE_NAME);

    // Fetch stream URL and schedule in parallel, then play
    const streamPromise = self.getStreamUrl(channelKey);
    // the schedule only decorates: when it cannot be read the channel plays under its own name
    const schedulePromise = self.fetchSchedule(channelKey).fail(function() {
        channel.programTitle = channel.name;
        channel.programActor = '';
        channel.albumart = channel.defaultAlbumart;
    });

    libQ.all([streamPromise, schedulePromise])
        .then(function(results) {
            const streamUrl = results[0];

            // another channel (or a stop) came while the address was on its way: this start is over
            if (!current()) {
                self.logger.info('[HanRadio] ' + channelKey + ' superseded before it played');
                defer.resolve();
                return;
            }
            self.logger.info('[HanRadio] Playing: ' + streamUrl);

            return self.mpdPlugin.sendMpdCommand('stop', [])
                .then(function() {
                    return self.mpdPlugin.sendMpdCommand('clear', []);
                })
                .then(function() {
                    return self.mpdPlugin.sendMpdCommand('add "' + streamUrl + '"', []);
                })
                .then(function() {
                    if (!current()) { return; }
                    self.commandRouter.pushToastMessage('info', 'Han Radio', channel.name + (reconnecting ? ' reconnecting...' : ' connecting...'));
                    return self.mpdPlugin.sendMpdCommand('play', []);
                })
                .then(function() {
                    if (!current()) { defer.resolve(); return; }
                    self.playStartedAt = Date.now();
                    self.pushCurrentState();
                    // Probe stream after 3 seconds to detect samplerate/bitrate
                    self.probeStreamAudioInfo();
                    self.startWatchdog();
                    defer.resolve();
                });
        })
        .fail(function(err) {
            self.logger.error('[HanRadio] Play failed: ' + err);
            if (!current()) { defer.reject(err); return; }   // another channel was chosen meanwhile
            self.isPlaying = false;
            self.commandRouter.pushToastMessage('error', 'Han Radio', channel.name + ': ' + ((err && err.message) || err));
            self.commandRouter.servicePushState({ status: 'stop', service: SERVICE_NAME, title: channel.name, albumart: channel.defaultAlbumart, uri: track.uri }, SERVICE_NAME);
            defer.reject(err);
        });

    return defer.promise;
};

ControllerHanRadio.prototype.pushCurrentState = function() {
    const self = this;

    if (!self.isPlaying || !self.currentChannel) return;

    const channel = self.channels[self.currentChannel];
    if (!channel) return;

    const title = channel.programTitle || channel.name;
    const artist = channel.programActor || channel.name;
    const albumart = channel.albumart || channel.defaultAlbumart;

    const state = {
        status: 'play',
        service: SERVICE_NAME,
        type: 'webradio',
        trackType: 'webradio',
        title: title,
        artist: artist,
        albumart: albumart,
        uri: self.currentUri,
        streaming: true,
        disableUiControls: true,
        duration: 0,
        seek: 0,
        samplerate: self.audioInfo.samplerate || '',
        bitdepth: self.audioInfo.bitdepth || '',
        bitrate: self.audioInfo.bitrate || '',
        channels: self.audioInfo.channels || 2
    };

    // Update queue item
    try {
        const vState = self.commandRouter.stateMachine.getState();
        const queueItem = self.commandRouter.stateMachine.playQueue.arrayQueue[vState.position];

        if (queueItem) {
            queueItem.name = title;
            queueItem.title = title;
            queueItem.artist = artist;
            queueItem.albumart = albumart;
            queueItem.trackType = channel.name;
            queueItem.duration = 0;
            queueItem.samplerate = self.audioInfo.samplerate || '';
            queueItem.bitdepth = self.audioInfo.bitdepth || '';
            queueItem.bitrate = self.audioInfo.bitrate || '';
            queueItem.channels = self.audioInfo.channels || 2;
        }

        self.commandRouter.stateMachine.currentSeek = 0;
        self.commandRouter.stateMachine.playbackStart = Date.now();
        self.commandRouter.stateMachine.currentSongDuration = 0;
        self.commandRouter.stateMachine.askedForPrefetch = false;
        self.commandRouter.stateMachine.prefetchDone = false;
        self.commandRouter.stateMachine.simulateStopStartDone = false;
    } catch (e) {
        self.logger.error('[HanRadio] Queue update failed: ' + e.message);
    }

    self.logger.info('[HanRadio] Now playing: ' + title + ' / ' + artist);
    self.commandRouter.servicePushState(state, SERVICE_NAME);
};

// Volumio calls stop() when the user stops or pauses, and also when another source starts: no toast here,
// the player's own state already shows it stopped
ControllerHanRadio.prototype.stop = function() {
    const self = this;

    self.isPlaying = false;
    self.playGen++;          // a start still on its way must not play after this
    self.stopWatchdog();

    if (self.probeTimer) {
        clearTimeout(self.probeTimer);
        self.probeTimer = null;
    }

    self.commandRouter.servicePushState({
        status: 'stop',
        service: SERVICE_NAME
    }, SERVICE_NAME);

    return self.mpdPlugin.stop();
};

// ═══════════════════════════════════════════════════════════════════════════
// WATCHDOG: while a channel should be playing, MPD is asked every WATCHDOG_MS whether it is. When the
// stream has stopped by itself (a network drop, an HLS error) the channel is started again with a fresh
// address, at most RECONNECT_MAX times in RECONNECT_WINDOW_MS; after that it stays stopped with a message.
// ═══════════════════════════════════════════════════════════════════════════

const WATCHDOG_MS = 15 * 1000;
const START_GRACE_MS = 25 * 1000;          // a stream that has just been started may take this long to play
const RECONNECT_MAX = 3;
const RECONNECT_WINDOW_MS = 10 * 60 * 1000;

ControllerHanRadio.prototype.startWatchdog = function() {
    const self = this;
    self.stopWatchdog();
    self.watchdogTimer = setInterval(function() { self.checkStream(); }, WATCHDOG_MS);
};

ControllerHanRadio.prototype.stopWatchdog = function() {
    const self = this;
    if (self.watchdogTimer) {
        clearInterval(self.watchdogTimer);
        self.watchdogTimer = null;
    }
};

// what Volumio thinks plays: the watchdog acts only while that is still this plugin's channel
ControllerHanRadio.prototype.volumioPlaysUs = function() {
    const self = this;
    try {
        const st = self.commandRouter.stateMachine.getState();
        return !!st && st.service === SERVICE_NAME && st.status === 'play' && (!st.uri || st.uri === self.currentUri);
    } catch (e) {
        return true;   // no state machine to ask (an older Volumio): trust our own flag
    }
};

ControllerHanRadio.prototype.checkStream = function() {
    const self = this;
    if (!self.isPlaying || !self.currentUri) { self.stopWatchdog(); return; }
    if (Date.now() - self.playStartedAt < START_GRACE_MS) { return; }
    if (!self.volumioPlaysUs()) {
        self.logger.info('[HanRadio] Volumio no longer plays Han Radio: watchdog off');
        self.isPlaying = false;
        self.stopWatchdog();
        return;
    }
    const gen = self.playGen;
    self.mpdPlugin.sendMpdCommand('status', [])
        .then(function(status) {
            if (gen !== self.playGen || !self.isPlaying) { return; }
            const state = self.findMpdField(status, 'state');
            if (state === 'play') { return; }
            const mpdError = self.findMpdField(status, 'error');
            self.reconnect('MPD ' + (state || 'unknown') + (mpdError ? ' (' + mpdError + ')' : ''));
        })
        .fail(function(err) {
            self.logger.warn('[HanRadio] Watchdog could not ask MPD: ' + (err && err.message ? err.message : err));
        });
};

ControllerHanRadio.prototype.reconnect = function(reason) {
    const self = this;
    const now = Date.now();
    self.reconnects = self.reconnects.filter(function(t) { return now - t < RECONNECT_WINDOW_MS; });
    const channel = self.channels[self.currentChannel] || { name: 'Han Radio' };
    if (self.reconnects.length >= RECONNECT_MAX) {
        self.logger.error('[HanRadio] Stream stopped (' + reason + ') and ' + RECONNECT_MAX + ' reconnects in ' + (RECONNECT_WINDOW_MS / 60000) + ' min failed: giving up');
        self.commandRouter.pushToastMessage('error', 'Han Radio', channel.name + ': stream lost');
        self.stop();
        return;
    }
    self.reconnects.push(now);
    self.logger.warn('[HanRadio] Stream stopped (' + reason + '): reconnect ' + self.reconnects.length + '/' + RECONNECT_MAX);
    self.stopWatchdog();
    self.clearAddPlayTrack({ uri: self.currentUri }, true).fail(function() { /* clearAddPlayTrack logged it */ });
};

ControllerHanRadio.prototype.pause = function() {
    const self = this;
    return self.stop();
};

ControllerHanRadio.prototype.resume = function() {
    const self = this;
    if (self.currentUri) {
        return self.clearAddPlayTrack({ uri: self.currentUri });
    }
    return libQ.resolve();
};

// ═══════════════════════════════════════════════════════════════════════════
// BROWSE / NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.addToBrowseSources = function() {
    const self = this;
    self.commandRouter.volumioAddToBrowseSources({
        name: 'Han Radio',
        uri: 'hanradio',
        plugin_type: 'music_service',
        plugin_name: SERVICE_NAME,
        albumart: '/albumart?sourceicon=music_service/hanradio/hanradio.svg'
    });
};

ControllerHanRadio.prototype.removeFromBrowseSources = function() {
    const self = this;
    self.commandRouter.volumioRemoveToBrowseSources('Han Radio');
};

ControllerHanRadio.prototype.handleBrowseUri = function(curUri) {
    const self = this;
    if (curUri.indexOf('hanradio') === 0) {
        return self.browseRoot();
    }
    return libQ.resolve({ navigation: { lists: [] } });
};

// the channel list: each channel with the picture, title and host of the programme on air now. The schedules
// are asked in parallel and waited for BROWSE_WAIT_MS at most; a channel whose schedule has not come by then
// shows its logo (the answer still lands in the cache for the next time the list opens).
ControllerHanRadio.prototype.browseRoot = function() {
    const self = this;
    const keys = Object.keys(self.channels);

    return libQ.all(keys.map(function(key) {
        return self.within(self.getNowProgram(key), BROWSE_WAIT_MS);
    })).then(function(programs) {
        const items = keys.map(function(key, i) {
            const channel = self.channels[key];
            const p = programs[i];
            const item = {
                service: SERVICE_NAME,
                type: 'mywebradio',
                title: channel.name,
                // no icon: an interface draws an item's icon over its picture
                uri: 'hanradio/' + key,
                albumart: (p && p.image) || channel.defaultAlbumart
            };
            if (p && p.title) {
                item.artist = p.title;               // the programme on air, under the channel's name
                if (p.actor) { item.album = p.actor; }
            }
            return item;
        });
        return {
            navigation: {
                lists: [{
                    availableListViews: ['list', 'grid'],
                    items: items
                }],
                prev: { uri: '/' }
            }
        };
    });
};

ControllerHanRadio.prototype.explodeUri = function(uri) {
    const self = this;
    const defer = libQ.defer();

    const channelKey = self.getChannelFromUri(uri);
    const channel = self.channels[channelKey];

    if (!channel) {
        defer.reject('Unknown channel');
        return defer.promise;
    }

    defer.resolve([{
        service: SERVICE_NAME,
        type: 'track',
        trackType: 'webradio',
        radioType: SERVICE_NAME,
        title: channel.name,
        name: channel.name,
        uri: uri,
        albumart: channel.defaultAlbumart,
        duration: 0
    }]);

    return defer.promise;
};

ControllerHanRadio.prototype.search = function(query) {
    return libQ.resolve([]);
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.getChannelFromUri = function(uri) {
    const self = this;
    if (!uri) return 'kbs-classic-fm';
    const parts = uri.split('/');
    if (parts[0] === 'hanradio' && parts.length >= 2) {
        if (self.channels[parts[1]]) return parts[1];
    }
    return 'kbs-classic-fm';
};