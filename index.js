'use strict';

/**
 * Han Radio Plugin v1.0.0
 * Korean Internet Radio - KBS Classic FM & CBS Music FM
 * Volumio Standard Pattern (function/prototype)
 */

var libQ = require('kew');
var https = require('https');
var http = require('http');

var SERVICE_NAME = 'hanradio';

module.exports = ControllerHanRadio;

function ControllerHanRadio(context) {
    var self = this;

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
    var self = this;
    return libQ.resolve();
};

ControllerHanRadio.prototype.onStart = function() {
    var self = this;
    var defer = libQ.defer();

    self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
    self.addToBrowseSources();
    self.startScheduleTimer();
    self.logger.info('[HanRadio] Plugin started');

    defer.resolve();
    return defer.promise;
};

ControllerHanRadio.prototype.onStop = function() {
    var self = this;
    var defer = libQ.defer();

    self.stopScheduleTimer();
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
    var self = this;
    return libQ.resolve();
};

ControllerHanRadio.prototype.getConfigurationFiles = function() {
    return [];
};

// ═══════════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.httpGet = function(requestUrl) {
    var self = this;
    var defer = libQ.defer();

    var protocol = requestUrl.startsWith('https') ? https : http;

    protocol.get(requestUrl, function(response) {
        var data = '';

        response.on('data', function(chunk) {
            data += chunk;
        });

        response.on('end', function() {
            if (response.statusCode === 200) {
                try {
                    var json = JSON.parse(data);
                    defer.resolve(json);
                } catch (e) {
                    self.logger.error('[HanRadio] JSON parse error: ' + e.message);
                    defer.reject(e);
                }
            } else {
                self.logger.error('[HanRadio] HTTP error: ' + response.statusCode);
                defer.reject(new Error('HTTP ' + response.statusCode));
            }
        });

        response.on('error', function(err) {
            self.logger.error('[HanRadio] HTTP response error: ' + err.message);
            defer.reject(err);
        });
    }).on('error', function(err) {
        self.logger.error('[HanRadio] HTTP request error: ' + err.message);
        defer.reject(err);
    });

    return defer.promise;
};

ControllerHanRadio.prototype.httpGetText = function(requestUrl) {
    var self = this;
    var defer = libQ.defer();

    var protocol = requestUrl.startsWith('https') ? https : http;

    protocol.get(requestUrl, function(response) {
        var data = '';

        response.on('data', function(chunk) {
            data += chunk;
        });

        response.on('end', function() {
            if (response.statusCode === 200) {
                defer.resolve(data);
            } else {
                self.logger.error('[HanRadio] HTTP error: ' + response.statusCode);
                defer.reject(new Error('HTTP ' + response.statusCode));
            }
        });

        response.on('error', function(err) {
            defer.reject(err);
        });
    }).on('error', function(err) {
        defer.reject(err);
    });

    return defer.promise;
};

// ═══════════════════════════════════════════════════════════════════════════
// STREAM URL
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.getStreamUrl = function(channelKey) {
    var self = this;
    var defer = libQ.defer();
    var channel = self.channels[channelKey];

    if (!channel) {
        defer.reject(new Error('Unknown channel: ' + channelKey));
        return defer.promise;
    }

    if (channelKey === 'cbs-music-fm') {
        defer.resolve(channel.streamUrl);
        return defer.promise;
    }

    // KBS Classic FM: fetch stream URL from API
    self.httpGet(channel.streamApiUrl)
        .then(function(data) {
            // API response contains channel_item array with service_url
            var channelItems = data.channel_item;
            if (Array.isArray(channelItems) && channelItems.length > 0 && channelItems[0].service_url) {
                self.logger.info('[HanRadio] KBS stream URL: ' + channelItems[0].service_url);
                defer.resolve(channelItems[0].service_url);
                return;
            }

            self.logger.error('[HanRadio] No service_url found in KBS API response: ' + JSON.stringify(data));
            defer.reject(new Error('No stream URL found'));
        })
        .fail(function(err) {
            self.logger.error('[HanRadio] Failed to get KBS stream URL: ' + err.message);
            defer.reject(err);
        });

    return defer.promise;
};

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.fetchSchedule = function(channelKey) {
    var self = this;
    var defer = libQ.defer();
    var channel = self.channels[channelKey];

    if (!channel) {
        defer.reject(new Error('Unknown channel'));
        return defer.promise;
    }

    self.httpGet(channel.scheduleUrl)
        .then(function(data) {
            var now = new Date();
            var currentHour = now.getHours();
            var currentMin = now.getMinutes();

            if (channelKey === 'kbs-classic-fm') {
                self.parseKbsSchedule(data, currentHour, currentMin);
            } else if (channelKey === 'cbs-music-fm') {
                self.parseCbsSchedule(data, currentHour, currentMin);
            }

            defer.resolve();
        })
        .fail(function(err) {
            self.logger.error('[HanRadio] Schedule fetch failed for ' + channelKey + ': ' + err.message);
            defer.reject(err);
        });

    return defer.promise;
};

ControllerHanRadio.prototype.parseKbsSchedule = function(data, currentHour, currentMin) {
    var self = this;
    var channel = self.channels['kbs-classic-fm'];
    var dayData = Array.isArray(data) ? data[0] : data;
    var dailySchedules = (dayData && Array.isArray(dayData.schedules)) ? dayData.schedules : [];

    for (var i = 0; i < dailySchedules.length; i++) {
        var item = dailySchedules[i];

        var startTime = item.program_planned_start_time || '';
        var endTime = item.program_planned_end_time || '';

        var startHour = parseInt(startTime.substring(0, 2), 10);
        var endHour = parseInt(endTime.substring(0, 2), 10);
        var startMinStr = startTime.length >= 4 ? startTime.substring(2, 4) : '00';
        var endMinStr = endTime.length >= 4 ? endTime.substring(2, 4) : '00';
        var startMin = parseInt(startMinStr, 10);
        var endMin = parseInt(endMinStr, 10);

        var currentTotal = currentHour * 60 + currentMin;
        var startTotal = startHour * 60 + startMin;
        var endTotal = endHour * 60 + endMin;

        if (currentTotal >= startTotal && currentTotal < endTotal) {
            channel.programTitle = item.program_title || 'KBS Classic FM';
            channel.programActor = item.program_actor || '';
            channel.albumart = item.image_w || channel.defaultAlbumart;

            self.logger.info('[HanRadio] KBS schedule: ' + channel.programTitle + ' / ' + channel.programActor);
            return;
        }
    }

    // Fallback
    channel.programTitle = 'KBS Classic FM';
    channel.programActor = '';
    channel.albumart = channel.defaultAlbumart;
};

ControllerHanRadio.prototype.parseCbsSchedule = function(data, currentHour, currentMin) {
    var self = this;
    var channel = self.channels['cbs-music-fm'];
    // API returns object with numeric keys {"0":{}, "1":{}, ...}, not an array
    var schedules = [];
    if (Array.isArray(data)) {
        schedules = data;
    } else if (typeof data === 'object' && data !== null) {
        var keys = Object.keys(data);
        for (var k = 0; k < keys.length; k++) {
            if (data[keys[k]] && data[keys[k]].startTime) {
                schedules.push(data[keys[k]]);
            }
        }
    }

    for (var i = 0; i < schedules.length; i++) {
        var item = schedules[i];
        var startTime = item.startTime || '';
        var endTime = item.endTime || '';

        // Parse HH:MM or HHMM format
        var startParts = startTime.indexOf(':') >= 0 ? startTime.split(':') : [startTime.substring(0, 2), startTime.substring(2, 4)];
        var endParts = endTime.indexOf(':') >= 0 ? endTime.split(':') : [endTime.substring(0, 2), endTime.substring(2, 4)];

        var startHour = parseInt(startParts[0], 10);
        var startMin = parseInt(startParts[1] || '0', 10);
        var endHour = parseInt(endParts[0], 10);
        var endMin = parseInt(endParts[1] || '0', 10);

        var currentTotal = currentHour * 60 + currentMin;
        var startTotal = startHour * 60 + startMin;
        var endTotal = endHour * 60 + endMin;

        if (currentTotal >= startTotal && currentTotal < endTotal) {
            channel.programTitle = item.name || 'CBS Music FM';
            // mc is in item.program.mc, top-level mc is empty
            channel.programActor = (item.program && item.program.mc) || item.mc || '';

            var mobileTop = (item.program && item.program.image && item.program.image.mobileTop) || '';
            if (mobileTop) {
                if (mobileTop.indexOf('http') !== 0) {
                    channel.albumart = 'https://cbs.co.kr' + mobileTop;
                } else {
                    channel.albumart = mobileTop;
                }
            } else {
                channel.albumart = channel.defaultAlbumart;
            }

            self.logger.info('[HanRadio] CBS schedule: ' + channel.programTitle + ' / ' + channel.programActor);
            return;
        }
    }

    // Fallback
    channel.programTitle = 'CBS Music FM';
    channel.programActor = '';
    channel.albumart = channel.defaultAlbumart;
};

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE TIMER (every 30 minutes on the hour and half hour)
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.startScheduleTimer = function() {
    var self = this;

    self.stopScheduleTimer();

    var scheduleNext = function() {
        var now = new Date();
        var minutes = now.getMinutes();
        var seconds = now.getSeconds();
        var ms = now.getMilliseconds();

        // Calculate ms until next :00 or :30
        var nextMin = minutes < 30 ? 30 : 60;
        var delayMs = ((nextMin - minutes) * 60 - seconds) * 1000 - ms;

        if (delayMs <= 0) {
            delayMs = 1000;
        }

        self.scheduleTimer = setTimeout(function() {
            self.updateCurrentSchedule();
            scheduleNext();
        }, delayMs);
    };

    scheduleNext();
};

ControllerHanRadio.prototype.stopScheduleTimer = function() {
    var self = this;
    if (self.scheduleTimer) {
        clearTimeout(self.scheduleTimer);
        self.scheduleTimer = null;
    }
};

ControllerHanRadio.prototype.updateCurrentSchedule = function() {
    var self = this;

    if (!self.isPlaying || !self.currentChannel) {
        return;
    }

    self.logger.info('[HanRadio] Updating schedule for ' + self.currentChannel);

    self.fetchSchedule(self.currentChannel)
        .then(function() {
            var channel = self.channels[self.currentChannel];
            if (channel && self.isPlaying) {
                self.pushCurrentState();
            }
        })
        .fail(function(err) {
            self.logger.error('[HanRadio] Schedule update failed: ' + err.message);
        });
};

// ═══════════════════════════════════════════════════════════════════════════
// AUDIO PROBE (detect samplerate/bitrate from MPD after 3 seconds)
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.probeStreamAudioInfo = function() {
    var self = this;

    if (self.probeTimer) {
        clearTimeout(self.probeTimer);
        self.probeTimer = null;
    }

    self.probeTimer = setTimeout(function() {
        self.probeTimer = null;

        if (!self.isPlaying) return;

        // CBS Music FM: parse m3u8 for bitrate, then probe MPD for samplerate/bitdepth
        var bitratePromise;
        if (self.currentChannel === 'cbs-music-fm') {
            var channel = self.channels['cbs-music-fm'];
            bitratePromise = self.parseM3u8Bitrate(channel.streamUrl);
        } else {
            bitratePromise = libQ.resolve();
        }

        bitratePromise
            .then(function() {
                return self.mpdPlugin.sendMpdCommand('status', []);
            })
            .then(function(mpdStatus) {
                self.parseMpdAudioInfo(mpdStatus);
                self.pushCurrentState();
            })
            .fail(function(err) {
                self.logger.error('[HanRadio] Audio probe failed: ' + err.message);
            });
    }, 3000);
};

ControllerHanRadio.prototype.parseM3u8Bitrate = function(m3u8Url) {
    var self = this;
    var defer = libQ.defer();

    self.httpGetText(m3u8Url)
        .then(function(text) {
            // Parse BANDWIDTH or AVERAGE-BANDWIDTH from #EXT-X-STREAM-INF line
            var match = text.match(/AVERAGE-BANDWIDTH=(\d+)/);
            if (!match) {
                match = text.match(/BANDWIDTH=(\d+)/);
            }
            if (match) {
                var bps = parseInt(match[1], 10);
                var kbps = Math.round(bps / 1000);
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
    var self = this;

    // MPD status 'audio' field format: "samplerate:bits:channels" e.g. "44100:24:2"
    var audio = self.findMpdField(mpdStatus, 'audio');
    var bitrate = self.findMpdField(mpdStatus, 'bitrate');

    if (audio) {
        var parts = audio.split(':');
        if (parts.length >= 3) {
            var sr = parseInt(parts[0], 10);
            var bits = parseInt(parts[1], 10);
            var ch = parseInt(parts[2], 10);

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
        var br = parseInt(bitrate, 10);
        if (br > 0) {
            self.audioInfo.bitrate = br + ' kbps';
        }
    }

    // Volumio Player State에서 bitrate 항목은 없어서 bitdepth에 bitrate 같이 표시함
    if (self.audioInfo.samplerate) {
        self.audioInfo.samplerate = ' ~ ' + self.audioInfo.samplerate;
    }
    if (self.audioInfo.bitdepth || self.audioInfo.bitrate) {
        self.audioInfo.bitdepth = (self.audioInfo.bitdepth || '') + (self.audioInfo.bitrate ? ' ' + self.audioInfo.bitrate : '');
    }
    

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
        var lines = mpdResult.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
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

ControllerHanRadio.prototype.clearAddPlayTrack = function(track) {
    var self = this;
    var defer = libQ.defer();

    var channelKey = self.getChannelFromUri(track.uri);
    self.currentChannel = channelKey;
    self.currentUri = track.uri;
    self.isPlaying = true;

    // Reset audio info for new stream
    self.audioInfo = { samplerate: '', bitdepth: '', bitrate: '', channels: 2 };

    var channel = self.channels[channelKey];
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
    var streamPromise = self.getStreamUrl(channelKey);
    var schedulePromise = self.fetchSchedule(channelKey);

    libQ.all([streamPromise, schedulePromise])
        .then(function(results) {
            var streamUrl = results[0];

            self.logger.info('[HanRadio] Playing: ' + streamUrl);

            return self.mpdPlugin.sendMpdCommand('stop', [])
                .then(function() {
                    return self.mpdPlugin.sendMpdCommand('clear', []);
                })
                .then(function() {
                    return self.mpdPlugin.sendMpdCommand('add "' + streamUrl + '"', []);
                })
                .then(function() {
                    self.commandRouter.pushToastMessage('info', 'Han Radio', channel.name + ' connecting...');
                    return self.mpdPlugin.sendMpdCommand('play', []);
                })
                .then(function() {
                    self.pushCurrentState();
                    // Probe stream after 3 seconds to detect samplerate/bitrate
                    self.probeStreamAudioInfo();
                    defer.resolve();
                });
        })
        .fail(function(err) {
            self.logger.error('[HanRadio] Play failed: ' + err);
            self.isPlaying = false;
            defer.reject(err);
        });

    return defer.promise;
};

ControllerHanRadio.prototype.pushCurrentState = function() {
    var self = this;

    if (!self.isPlaying || !self.currentChannel) return;

    var channel = self.channels[self.currentChannel];
    if (!channel) return;

    var title = channel.programTitle || channel.name;
    var artist = channel.programActor || channel.name;
    var albumart = channel.albumart || channel.defaultAlbumart;

    var state = {
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
        var vState = self.commandRouter.stateMachine.getState();
        var queueItem = self.commandRouter.stateMachine.playQueue.arrayQueue[vState.position];

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

ControllerHanRadio.prototype.stop = function() {
    var self = this;

    self.isPlaying = false;

    if (self.probeTimer) {
        clearTimeout(self.probeTimer);
        self.probeTimer = null;
    }

    self.commandRouter.pushToastMessage('info', 'Han Radio', 'Stopped playback');

    self.commandRouter.servicePushState({
        status: 'stop',
        service: SERVICE_NAME
    }, SERVICE_NAME);

    return self.mpdPlugin.stop();
};

ControllerHanRadio.prototype.pause = function() {
    var self = this;
    return self.stop();
};

ControllerHanRadio.prototype.resume = function() {
    var self = this;
    if (self.currentUri) {
        return self.clearAddPlayTrack({ uri: self.currentUri });
    }
    return libQ.resolve();
};

// ═══════════════════════════════════════════════════════════════════════════
// BROWSE / NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

ControllerHanRadio.prototype.addToBrowseSources = function() {
    var self = this;
    self.commandRouter.volumioAddToBrowseSources({
        name: 'Han Radio',
        uri: 'hanradio',
        plugin_type: 'music_service',
        plugin_name: SERVICE_NAME,
        albumart: '/albumart?sourceicon=music_service/hanradio/hanradio.svg'
    });
};

ControllerHanRadio.prototype.removeFromBrowseSources = function() {
    var self = this;
    self.commandRouter.volumioRemoveToBrowseSources('Han Radio');
};

ControllerHanRadio.prototype.handleBrowseUri = function(curUri) {
    var self = this;
    if (curUri.indexOf('hanradio') === 0) {
        return self.browseRoot();
    }
    return libQ.resolve({ navigation: { lists: [] } });
};

ControllerHanRadio.prototype.browseRoot = function() {
    var self = this;
    var defer = libQ.defer();
    var items = [];

    items.push({
        service: SERVICE_NAME,
        type: 'mywebradio',
        title: 'KBS Classic FM',
        icon: 'fa fa-music',
        uri: 'hanradio/kbs-classic-fm',
        albumart: '/albumart?sourceicon=music_service/hanradio/images/kbs-classic-fm.png'
    });

    items.push({
        service: SERVICE_NAME,
        type: 'mywebradio',
        title: 'CBS Music FM',
        icon: 'fa fa-music',
        uri: 'hanradio/cbs-music-fm',
        albumart: '/albumart?sourceicon=music_service/hanradio/images/cbs-music-fm.png'
    });

    defer.resolve({
        navigation: {
            lists: [{
                availableListViews: ['list', 'grid'],
                items: items
            }],
            prev: { uri: '/' }
        }
    });

    return defer.promise;
};

ControllerHanRadio.prototype.explodeUri = function(uri) {
    var self = this;
    var defer = libQ.defer();

    var channelKey = self.getChannelFromUri(uri);
    var channel = self.channels[channelKey];

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
    var self = this;
    if (!uri) return 'kbs-classic-fm';
    var parts = uri.split('/');
    if (parts[0] === 'hanradio' && parts.length >= 2) {
        if (self.channels[parts[1]]) return parts[1];
    }
    return 'kbs-classic-fm';
};
