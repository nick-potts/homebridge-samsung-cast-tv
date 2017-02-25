const Promise = require('bluebird');
const SamsungRemote = require('samsung-remote');
const inherits = require('util').inherits;
const { Client, DefaultMediaReceiver } = require('castv2-client');

/**
 * Just a little helper that guarantees that the callback function is only callable once.
 *
 * @param {Function} callback The actual callback.
 */
function DisposableCallback(callback) {
	var _callback = callback
	return function () {
		_callback.apply(this, arguments)
		_callback = function () {
			console.log('Warning: Attempt to call disposable callback twice.')
		}
	}
}

module.exports = function (homebridge) {
	homebridge.registerAccessory("homebridge-samsung-cast-tv", "SamsungCastTV", function (log, config, api) {
		return new SamsungCastTv(homebridge, log, config, api);
	});
};

class SamsungCastTv {
	constructor(homebridge, log, config, api) {
		// Save args
		this.log = log;
		this.config = config;
		this.api = api;
		// Setup Homebridge
		this.Service = homebridge.hap.Service;
		this.Characteristic = homebridge.hap.Characteristic;
		// Setup SamsungTV and Chromecast
		const {
			samsung: samsungConfig,
			chromecast: chromecastConfig,
		} = config;
		this.samsungTv = new SamsungTv(samsungConfig, log);
		this.chromecast = new Chromecast(chromecastConfig.ip, log);
		this.chromecast.connect();

		this.service = new this.Service.Switch(this.name);
		this.setupCharacteristics();
		this.tick();
	}

	get name() {
		return this.config.name;
	}

	getInformationService() {
		const { Service, Characteristic } = this;
		var informationService = new Service.AccessoryInformation();
		informationService
			.setCharacteristic(Characteristic.Name, this.name)
			.setCharacteristic(Characteristic.Manufacturer, 'Samsung TV')
			.setCharacteristic(Characteristic.Model, '1.0.0')
			.setCharacteristic(Characteristic.SerialNumber, this.ip_address);
		return informationService;
	}

	getServices() {
		return [this.service, this.getInformationService()];
	}

	setupCharacteristics() {
		const { Characteristic } = this;
		const power = this.service
			.getCharacteristic(Characteristic.On)
			.on('get', this.getPowerOn.bind(this))
			.on('set', this.setPowerOn.bind(this))
			;
		// const mute = this.service
		// 	.addCharacteristic(Characteristic.Mute)
		// 	.on('get', this.getChromecastMute.bind(this))
		// 	.on('set', this.setChromecastMute.bind(this))
		// 	;
		const volume = this.service
			.addCharacteristic(Characteristic.Volume)
			.on('get', this.getChromecastVolume.bind(this))
			.on('set', this.setChromecastVolume.bind(this))
			;

		this.characteristics = {
			power,
			// mute,
			volume,
		};
	}

	tick() {
		const { log } = this;
		log.debug("Tick");
		return this.updateValues()
			.then(() => setTimeout(() => this.tick(), this.pollInterval))
			.catch(() => setTimeout(() => this.tick(), this.pollInterval))
			;
	}

	get pollInterval() {
		return 2000;
	}

	updateValues() {
		return Promise.all([
			this.updateSamsungPower(),
			this.updateChromecastVolume(),
		]).timeout(this.pollInterval);
	}

	updateSamsungPower() {
		return this.isSamsungActive
			.then(isOn => this.characteristics.power.updateValue(isOn));
	}

	get isSamsungActive() {
		return this.samsungTv.isActive;
	}

	getPowerOn(callback) {
		return this.isSamsungActive
			.then(isOn => callback(null, isOn))
			.catch(error => callback(error))
			;
	}

	setPowerOn(isOn, callback) {
		const { log } = this;
		log.debug("isOn", isOn);
		const promise = isOn ? this.samsungTv.powerOn() : this.samsungTv.powerOff();
		return promise
			.catch(error => {
				if (isOn) {
					return Promise.resolve(this.chromecast.powerOn());
				}
				return Promise.reject(error);
			})
			.then(() => callback())
			.catch(error => {
				log.error(error);
				callback(error);
			})
			;
	}

	updateChromecastVolume() {
		return this.chromecastVolume
			.then(volume => this.characteristics.volume.updateValue(volume));	
	}

	get chromecastVolume() {
		return this.chromecast.volume;
	}

	getChromecastVolume(callback) {
		return this.chromecast.volume
			.then(volume => callback(null, volume))
			.catch(error => callback(error))
			;
	}

	setChromecastVolume(newVolume, callback) {
		return this.chromecast.setVolume(newVolume)
			.then(() => callback())
			.catch(error => callback(error))
			;
	}

}

class SamsungTv {
	constructor(customConfig, log) {
		const config = Object.assign({}, {
			timeout: 1000
		}, customConfig);
		this.remote = new SamsungRemote(config);
		this.log = log;
	}

	get isActive() {
		const { log } = this;
		return new Promise((resolve, reject) => {
			this.remote.isAlive(error => {
				if (error) {
					log.debug('TV is offline: %s', error);
					resolve(false);
				} else {
					log.debug('TV is alive.');
					resolve(true);
				}
			});
		});
	}

	send(key) {
		const { log } = this;
		return new Promise((resolve, reject) => {
			this.remote.send(key, err => {
				if (err) {
					log.debug('Could not turn TV on: %s', err);
					reject(new Error(err));
				} else {
					log.debug('TV successfully turnen on');
					resolve();
				}
			});
		});
	}

	powerOn() {
		return this.send('KEY_POWERON');
	}

	powerOff() {
		return this.send('KEY_POWEROFF');
	}

	toggleMute() {
		return this.send('KEY_MUTE');
	}

}

class Chromecast {
	constructor(host, log) {
		this.host = host;
		this.log = log;
		this.client = new Client();
		this.connected = false;
		this.connecting = false;
	}

	connect() {
		const { client, host, log } = this;
		return new Promise((resolve, reject) => {
			this.connecting = true;
			client.connect(host, () => {
				log.debug('connected, launching app ...', host);
				this.connected = true;
				this.connecting = false;
				resolve();
			});
			client.on('error', function (error) {
				log.debug('Error: %s', error.message);
				client.close();
				this.connected = false;
				this.connecting = false;
				reject(error);
			});
		});
	}

	powerOn() {
		// const { client, log } = this;
		// return new Promise((resolve, reject) =>
		// 	client.getSessions((error, sessions) =>
		// 		// log.debug("sessions", error, sessions)
		// 	// client.getStatus((error, status) =>
		// 	// 	log.debug("status", error, status)
		// 		client.join(sessions[0], DefaultMediaReceiver, (error, player) => {
		// 			if (error) {
		// 				reject(error);
		// 			} else {
		// 				player.on('status', function (status) {
		// 					log.debug('status broadcast playerState=%s', status.playerState);
		// 				});
		// 				log.debug('app "%s" launched, loading media %s ...', player.session.displayName);
		// 				resolve();
		// 			}
		// 		})
		// 	)
		// );
		this.launch();
		return Promise.resolve();
	}

	launch(receiver = DefaultMediaReceiver) {
		const { client, log } = this;
		return new Promise((resolve, reject) => {
			log.debug("Launching Chromecast");
			client.launch(receiver, function (error, player) {
				if (error) {
					reject(error);
				} else {
					player.on('status', function (status) {
						log.debug('status broadcast playerState=%s', status.playerState);
					});
					log.debug('app "%s" launched, loading media %s ...', player.session.displayName);
					resolve();
				}
			});
		});
	}

	get volume() {
		const { client, log, connected } = this;
		if (!connected) {
			return Promise.reject(new Error("Not connected to Chromecast."));
		}
		return new Promise((resolve, reject) =>
			client.getStatus((error, status) => {
				const volume = status.volume.level * 100;
				log.debug("Chromecast Volume", volume);
				if (error) {
					log.error(error)
					return reject(error);
				}
				return resolve(volume);
			})
		);
	}

	setVolume(newVolume) {
		const { client, log, connected } = this;
		if (!connected) {
			return Promise.reject(new Error("Not connected to Chromecast."));
		}
		return new Promise((resolve, reject) => {
			try {
				client.setVolume({ level: newVolume / 100 }, (error, currVolume) => {
					const volume = currVolume * 100;
					log.debug("Chromecast Volume", volume);
					if (error) {
						log.error(error)
						return reject(error);
					}
					return resolve(volume);
				});
			} catch (error) {
				log.error(error);
				reject(error);
			}
		});		
	}

}


function SamsungTvAccessory(log, config) {
	this.log = log;
	this.config = config;
	this.name = config["name"];
	const { samsung: samsungConfig } = config;
	this.ip_address = samsungConfig["ip"];
	this.send_delay = config["send_delay"] || 400;

	if (!this.ip_address) throw new Error("You must provide a config value for 'ip_address'.");

	this.remote = new SamsungRemote(samsungConfig);

	this.isSendingSequence = false;

	// The channel value can not be accessed on the tv
	// if the normal remote is used to change the channel
	// the value will not be updated therefore
	this.channel = 1;

	this.service = new Service.Switch(this.name);

	this.service
		.getCharacteristic(Characteristic.On)
		.on('get', this._getOn.bind(this))
		.on('set', this._setOn.bind(this));

	this.service
		.addCharacteristic(VolumeCharacteristic)
		.on('get', this._getVolume.bind(this))
		.on('set', this._setVolume.bind(this));

	this.service
		.addCharacteristic(ChannelCharacteristic)
		.on('get', this._getChannel.bind(this))
		.on('set', this._setChannel.bind(this));

	this.service
		.addCharacteristic(KeyCharacteristic)
		.on('get', this._getKey.bind(this))
		.on('set', this._setKey.bind(this));

	this.service
		.addCharacteristic(Characteristic.Mute)
		;

}

SamsungTvAccessory.prototype.getInformationService = function () {
	var informationService = new Service.AccessoryInformation();
	informationService
		.setCharacteristic(Characteristic.Name, this.name)
		.setCharacteristic(Characteristic.Manufacturer, 'Samsung TV')
		.setCharacteristic(Characteristic.Model, '1.0.0')
		.setCharacteristic(Characteristic.SerialNumber, this.ip_address);
	return informationService;
};

SamsungTvAccessory.prototype.getServices = function () {
	return [this.service, this.getInformationService()];
};

SamsungTvAccessory.prototype._getOn = function (callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)
	this.remote.isAlive(function (err) {
		if (err) {
			accessory.log.debug('TV is offline: %s', err);
			cb(null, false);
		} else {
			accessory.log.debug('TV is alive.');
			cb(null, true);
		}
	});
};

SamsungTvAccessory.prototype._setOn = function (on, callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)
	if (on) {
		this.remote.send('KEY_POWERON', function (err) {
			if (err) {
				accessory.log.debug('Could not turn TV on: %s', err);
				cb(new Error(err));
			} else {
				accessory.log.debug('TV successfully turnen on');
				cb(null);
			}
		});
	} else {
		this.remote.send('KEY_POWEROFF', function (err) {
			if (err) {
				accessory.log.debug('Could not turn TV off: %s', err);
				cb(new Error(err));
			} else {
				accessory.log.debug('TV successfully turnen off');
				cb(null);
			}
		});
	}
};

SamsungTvAccessory.prototype._getVolume = function (callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)
	cb(null, 25);
};

SamsungTvAccessory.prototype._setVolume = function (volume, callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)

	// Dismiss the request when another key sequence sending
	if (this.isSendingSequence) {
		cb(null);
		this.log.debug('Cannot send volume change by %s while sending other key sequence.', volume);
		return;
	}
	this.isSendingSequence = true;

	// When volume is 0, mute will be toggled
	if (volume === 0) {
		accessory.remote.send('KEY_MUTE', function (err) {
			if (err) {
				accessory.isSendingSequence = false;
				cb(new Error(err));
				accessory.log.error('Could not send mute key: %s', err);
				return;
			}
			accessory.log.debug('Finished sending mute key.');
			accessory.isSendingSequence = false;
			cb(null);
		});
		return;
	}

	this.log.debug('Changing volume by %s.', volume);

	var volumeKey = volume > 0 ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
	var absVolume = Math.abs(volume);

	function sendKey(index) {
		if (index > 0) {
			accessory.remote.send(volumeKey, function (err) {
				if (err) {
					accessory.isSendingSequence = false;
					callback(new Error(err));
					accessory.log.error('Could not send volume key %s: %s', volumeKey, err);
					return;
				}
				// Send the next key after the specified delay
				setTimeout(function () {
					sendKey(--index)
				}, accessory.send_delay);
			});
			return;
		}
		accessory.log.debug('Finished changing volume by %s.', volume);
		accessory.isSendingSequence = false;
		cb(null);
	}
	sendKey(absVolume);
};


SamsungTvAccessory.prototype._getChannel = function (callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)

	cb(null, accessory.channel);
};

SamsungTvAccessory.prototype._setChannel = function (channel, callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)

	// Dismiss the request when another key sequence sending
	if (this.isSendingSequence) {
		cb(null);
		this.log.debug('Cannot send channel %s while sending other key sequence.', channel);
		return;
	}
	this.isSendingSequence = true;
	this.log.debug('Sending channel %s.', channel);

	var channelInt = parseInt(channel, 10);
	if (isNaN(channelInt) || channelInt < 1 || channelInt > 9999) {
		cb(new Error('Invalid channel "' + channel + '"'));
		this.log.error('Invalid channel "%s".', channel);
		return;
	}

	var chStr = channelInt.toString(),
		keys = [];
	for (var i = 0, j = chStr.length; i < j; ++i) {
		keys.push('KEY_' + chStr[i]);
	}
	// Add the enter key to the end
	keys.push('KEY_ENTER');

	function sendKey(index) {
		if (index < keys.length) {
			accessory.log.debug('Sending channel key %s.', keys[index]);
			accessory.remote.send(keys[index], function (err) {
				if (err) {
					accessory.isSendingSequence = false;
					cb(new Error(err));
					accessory.log.error('Could not send channel key %s: %s', keys[index], err);
					return;
				}

				// Send the next key after the specified delay
				setTimeout(function () {
					sendKey(++index)
				}, accessory.send_delay);
			});
			return;
		}
		accessory.log.debug('Finished sending channel %s.', channel);
		accessory.isSendingSequence = false;
		accessory.channel = channel;
		cb(null);
	}
	sendKey(0)
};

SamsungTvAccessory.prototype._getKey = function (callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)

	cb(null, accessory.key);
};

SamsungTvAccessory.prototype._setKey = function (key, callback) {
	var accessory = this;
	var cb = DisposableCallback(callback)

	// Dismiss the request when a key sequence is sending
	if (this.isSendingSequence) {
		cb(null);
		this.log.debug('Cannot send key %s while sending a key sequence.', key);
		return;
	}
	this.isSendingSequence = true;
	this.log.debug('Sending key %s.', key);

	accessory.remote.send('KEY_' + key.toUpperCase(), function (err) {
		if (err) {
			accessory.isSendingSequence = false;
			cb(new Error(err));
			accessory.log.error('Could not send key %s: %s', key, err);
			return;
		}
		accessory.log.debug('Finished sending key %s.', key);
		accessory.isSendingSequence = false;
		accessory.key = key;
		cb(null);
	});
};

/**
 * Custom characteristic for volume
 *
 * @return {Characteristic} The volume characteristic
 */
function makeVolumeCharacteristic() {

	VolumeCharacteristic = function () {
		Characteristic.call(this, 'Volume', '91288267-5678-49B2-8D22-F57BE995AA00');
		this.setProps({
			format: Characteristic.Formats.INT,
			unit: Characteristic.Units.PERCENTAGE,
			maxValue: 10,
			minValue: -10,
			minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
		});
		//this.value = this.getDefaultValue();
		this.value = 1;
	};

	inherits(VolumeCharacteristic, Characteristic);
}

/**
 * Custom characteristic for channel
 *
 * @return {Characteristic} The channel characteristic
 */
function makeChannelCharacteristic() {

	ChannelCharacteristic = function () {
		Characteristic.call(this, 'Channel', '212131F4-2E14-4FF4-AE13-C97C3232499D');
		this.setProps({
			format: Characteristic.Formats.STRING,
			unit: Characteristic.Units.NONE,
			//maxValue: 9999,
			//minValue: 1,
			//minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
		});
		//this.value = this.getDefaultValue();
		this.value = "1";
	};

	inherits(ChannelCharacteristic, Characteristic);
}

/**
 * Custom characteristic for any key
 * @see(https://github.com/natalan/samsung-remote) The key can be any remote key without the KEY_ at the beginning (e.g. MENU)
 *
 * @return {Characteristic} The key characteristic
 */
function makeKeyCharacteristic() {

	KeyCharacteristic = function () {
		Characteristic.call(this, 'Key', '2A6FD4DE-8103-4E58-BDAC-25835CD006BD');
		this.setProps({
			format: Characteristic.Formats.STRING,
			unit: Characteristic.Units.NONE,
			//maxValue: 10,
			//minValue: -10,
			//minStep: 1,
			perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
		});
		//this.value = this.getDefaultValue();
		this.value = "TV";
	};

	inherits(KeyCharacteristic, Characteristic);
}