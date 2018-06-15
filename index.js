const Promise = require('bluebird');
const SamsungRemote = require('samsung-remote');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const { Accessory } = require('homebridge-plugin-helpers');
var inherits = require('util').inherits;
var KeyCharacteristic;

module.exports = function (homebridge) {
	SamsungCastTv.register(homebridge);
	Characteristic = homebridge.hap.Characteristic;
	makeKeyCharacteristic();
};

function makeKeyCharacteristic() {

	KeyCharacteristic = function() {
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

class SamsungCastTv extends Accessory {

	static get pluginName() {
		return "homebridge-samsung-cast-tv";
	}
	
	static get accessoryName() {
		return "SamsungCastTV";
	}

	constructor(homebridge, log, config, api) {
		super();
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

	get manufacturer() {
		return "Samsung TV";
	}

	get model() {
		return "1.0.0";
	}

	get serialNumber() {
		return this.ip_address;
	}

	setupCharacteristics() {
		const { Characteristic } = this;
		const power = this.service
			.getCharacteristic(Characteristic.On)
			.on('get', this.getPowerOn.bind(this))
			.on('set', this.setPowerOn.bind(this))
			;

		const key = this.service
			.addCharacteristic(KeyCharacteristic)
			.on('get', this.getKey.bind(this))
			.on('set', this.setKey.bind(this));

		const volume = this.service
			.addCharacteristic(Characteristic.Volume)
			.on('get', this.getChromecastVolume.bind(this))
			.on('set', this.setChromecastVolume.bind(this))
			;

		this.characteristics = {
			power,
			// mute,
			volume,
			key
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
			this.updateKey()
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

	updateKey() {
		return null;
	}

	getKey(callback) {
		callback(null);
		return;
	}

	setKey(key, callback) {
		const { log } = this;
		log.debug("KEY_" + key.toUpperCase());

		return this.samsungTv.send("KEY_" + key.toUpperCase())
		.then(() => callback())
		.catch((error) => {
			log.error(error);
			callback(error);
		});
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
		return this.launch();
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
