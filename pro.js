// WS module doesn't work in browsers
const WebSocket = require( "ws" );
const EventEmitter = require( 'events' );

function hms2secs( hms ) {
	var a = hms.split( ":" ); // split it at the colons
	// the '+' prefix coerces the string to a number
	var seconds = +a[ 0 ] * 60 * 60 + +a[ 1 ] * 60 + +a[ 2 ];
	if ( isNaN( seconds ) ) seconds = 0;
	return seconds;
}
function timestring2secs( timestring ) {
	var match = timestring.match( /\s*(\d+:\d+)\s*([AP]M)/ );
	if ( !match ) return 0;
	let a = match[ 1 ].split( ":" );
	// the '+' prefix coerces the string to a number
	var seconds = +a[ 0 ] * 60 * 60 + +a[ 1 ] * 60;
	if ( isNaN( seconds ) ) seconds = 0;
	if ( match[ 2 ] == "PM" ) seconds += 12 * 60 * 60;
	return seconds;
}

class ProSlide {
	constructor ( uid = '', text = '', notes = '' ) {
		this.uid = uid;
		this.text = text;
		this.notes = notes;
	}
}

// listens to ProPresenter as a stage display client
class ProSDClient extends EventEmitter {
	constructor ( host, port, password, version = 6, parent ) {
		super();
		this.host = host;
		this.port = port;
		this.password = password;
		this.version = version;
		this.parent = parent;

		// internal state
		this.connected = false;
		this.active = false;

		// tracking propresenter state
		this.stage_message = '';
		this.system_time = { text: '', seconds: 0 };
		this.timers = []; // need to preserve order to sync with remote protocol
		this.slides = {
			current: new ProSlide(),
			next: new ProSlide(),
		};

		this.ondata = ( data ) => this.emit( 'data', data, this );
		this.onmsgupdate = ( data ) => this.emit( 'msgupdate', data, this );
		this.onsysupdate = ( data ) => this.emit( 'sysupdate', data, this );
		this.onslideupdate = ( data ) => this.emit( 'slideupdate', data, this );
		this.ontimerupdate = ( data ) => this.emit( 'timerupdate', data, this );

		this.connect();
	}

	notify() {
		this.emit( 'update', this );
	}

	status() {
		return {
			system_time: this.system_time,
			timers: this.timers,
			stage_message: this.stage_message,
			slides: this.slides,
			connected: this.connected,
			active: this.active,
		};
	}


	close() {
		this.ws?.terminate();
		this.connected = false;
		this.active = false;
		this.notify();
	}


	reconnect( delay = 0 ) {
		this.parent.log( `Attempting reconnect in ${delay} seconds.` );
		clearTimeout( this.reconnectTimeout );
		this.reconnectTimeout = setTimeout( () => {
			this.connect();
		}, delay * 1000 );
	}

	connect() {
		this.connected = false;
		this.active = false;

		clearTimeout( this.reconnectTimeout );

		let url = `ws://${this.host}:${this.port}/stagedisplay`;
		console.log( `ProSDClient: connecting to ${url}` );
		if ( this.ws ) this.close();
		try {
			this.ws = new WebSocket( url );
		} catch ( e ) {
			this.close();
			console.log( 'ERROR: Could not connect to ' + url );
			console.log( e );
			return;
		}

		this.ws.on( 'message', ( data ) => {
			this.check( JSON.parse( data ) );
			this.notify();
		} );

		this.ws.on( 'open', () => {
			this.connected = true;
			this.authenticate();
			this.notify();
		} );

		this.ws.on( 'close', () => {
			// this.ws.terminate();
			this.reconnect( 10 );
			this.connected = false;
			this.active = false;
			this.notify();
		} );

		this.ws.on( 'error', ( err ) => {
			this.parent.log( 'ProPresenter WebSocket Error:' );
			// this.parent.log(err);
			this.ws.terminate();
			this.reconnect( 30 );
			this.notify();
		} );

	}

	send( Obj ) {
		this.ws.send( JSON.stringify( Obj ) );
	}

	authenticate() {
		let auth = {
			pwd: this.password,
			ptl: this.version * 100 + 10,
			acn: 'ath',
		};
		this.send( auth );
	}

	check( data ) {
		this.parent.log( data );
		let newdata = {};
		switch ( data.acn ) {
			case 'ath':
				//{"acn":"ath","ath":true/false,"err":""}
				if ( data.ath ) {
					this.parent.log( 'ProPresenter Stage Display Client is Connected' );
					this.active = true;
					newdata = { type: 'authentication', data: true };
				} else {
					this.connected = false;
					this.active = false;
					newdata = { type: 'authentication', data: false };
				}
				break;
			case 'tmr':
				let exists = false;
				let t = {
					uid: data.uid,
					text: data.txt,
					seconds: hms2secs( data.txt ),
				};
				for ( let timer of this.timers ) {
					if ( timer.uid == t.uid ) {
						timer.text = t.text;
						timer.seconds = t.seconds;
						exists = true;
						break;
					}
				}
				if ( !exists ) {
					this.timers.push( t );
				}
				newdata = { type: 'timer', data: t };
				if ( this.ontimerupdate ) this.ontimerupdate( t );
				break;
			case 'sys':
				// { "acn": "sys", "txt": " 11:17 AM" }
				this.system_time = {
					text: data.txt,
					seconds: timestring2secs( data.txt ),
				};
				newdata = { type: 'systime', data: this.system_time };
				if ( this.onsysupdate ) this.onsysupdate( this.system_time );
				break;
			case 'msg':
				// { acn: 'msg', txt: 'Test' }
				this.stage_message = data.txt;
				newdata = { type: 'message', data: this.stage_message };
				if ( this.onmsgupdate ) this.onmsgupdate( this.stage_message );
				break;
			case 'fv':
				// we just got stage display slide information
				this.slides.current = new ProSlide();
				this.slides.next = new ProSlide();

				// the 'ary' object contains a list (unordered) of 4 items
				// where each item will be identified by the 'acn' field as
				// cs: current slide
				// csn: current slide notes
				// ns: next slide
				// nsn: next slide notes
				for ( let blob of data.ary ) {
					switch ( blob.acn ) {
						case 'cs':
							this.slides.current.uid = blob.uid;
							this.slides.current.text = blob.txt;
							break;
						case 'csn':
							this.slides.current.notes = blob.txt;
							break;
						case 'ns':
							this.slides.next.uid = blob.uid;
							this.slides.next.text = blob.txt;
							break;
						case 'nsn':
							this.slides.next.notes = blob.txt;
							break;
					}
				}
				newdata = { type: 'slides', data: this.slides };
				if ( this.onslideupdate ) this.onslideupdate( this.slides );
		}
		if ( this.ondata ) this.ondata( newdata, this );
	}
}

// incomplete at the moment
class ProRemoteClient extends EventEmitter {
	constructor ( host, port, password, version = 6, parent ) {
		super();
		this.connected = false;
		this.controlling = false;
		this.host = host;
		this.port = port;
		this.password = password;
		this.version = version;
		this.parent = parent;

		this.callbacks = {};

		// handle pro6 status
		this.status = {
			clocks: [],
			currentPresentation: null,
			currentSlideIndex: 0,
			library: [],
			playlists: [],
		};

		this.connect();
	}

	close() {
		this.ws?.terminate();
		this.connected = false;
		this.controlling = false;
		this.notify();
	}

	reconnect( delay = 0 ) {
		this.parent.log( `Attempting reconnect in ${delay} seconds.` );
		clearTimeout( this.reconnectTimeout );
		this.reconnectTimeout = setTimeout( () => {
			this.connect();
		}, delay * 1000 );
	}


	connect() {
		this.connected = false;
		this.controlling = false;

		clearTimeout( this.reconnectTimeout );

		let url = `ws://${this.host}:${this.port}/remote`;
		console.log( `ProRemote: connecting to ${url}` );
		if ( this.ws ) this.close();
		try {
			this.ws = new WebSocket( url );
		} catch ( e ) {
			this.close();
			console.log( 'ERROR: Could not connect to ' + url );
			console.log( e );
			return;
		}

		this.ws.on( 'message', ( data ) => {
			data = JSON.parse( data );
			this.parent.log( data );
			this.handleData( data );
			// this.notify();
		} );
		this.ws.on( 'open', () => {
			this.authenticate();
			this.notify();
		} );
		this.ws.on( 'close', () => {
			this.connected = false;
			this.controlling = false;
			this.reconnect( 10 );
			this.notify();
		} );
		this.ws.on( 'error', () => {
			this.connected = false;
			this.controlling = false;
			this.reconnect( 30 );
			this.notify();
		} );
	}

	// notify is used for any status updates
	notify() {
		this.emit( 'update', this );
	}

	send( Obj, callback = null ) {
		// register callback if there is one.
		if ( typeof callback == 'function' ) {
			// fix api bug
			let responseAction = Obj.action;
			if ( Obj.action == 'presentationRequest' )
				responseAction = 'presentationCurrent';
			this.callbacks[ responseAction ] = callback;
		}
		this.ws.send( JSON.stringify( Obj ) );
	}

	authenticate() {
		let auth = {
			password: this.password,
			protocol: this.version * 100,
			action: 'authenticate',
		};
		this.send( auth );
	}

	flattenPlaylist( playlistObj ) {
		let flattened = [];
		switch ( playlistObj.playlistType ) {
			case 'playlistTypePlaylist':
				flattened = playlistObj.playlist;
				break;
			case 'playlistTypeGroup':
				for ( let playlist of playlistObj.playlist ) {
					flattened.push( ...this.flattenPlaylist( playlist ) );
				}
				break;
		}
		return flattened;
	}

	loadStatus() {
		this.getClocks();
		this.getLibrary();
		this.getPlaylists();
		this.getPresentation();
		this.getCurrentSlideIndex();
		// if the stage display client is connected
		this.subscribeClocks();
	}

	handleData( data ) {
		// process data for this class instance
		switch ( data.action ) {
			case 'authenticate':
				if ( data.authenticated == 1 ) this.connected = true;
				if ( data.controller == 1 ) this.controlling = true;

				if ( this.connected ) this.loadStatus();
				break;
			case 'libraryRequest':
				this.status.library = data.library;
				break;
			case 'playlistRequestAll':
				this.status.playlists = this.flattenPlaylist( data.playlistAll );
				break;
			case 'presentationCurrent':
				this.status.currentPresentation = data.presentation;
				break;
			case 'presentationSlideIndex':
				this.status.currentSlideIndex = +data.slideIndex;
				break;
			case 'presentationTriggerIndex':
				this.status.currentSlideIndex = +data.slideIndex;
				if ( this.status.currentPresentation != data.presentationPath ) {
					this.getPresentation( data.presentationPath );
				}
				break;
			case 'clockRequest':
			case 'clockDeleteAdd':
				this.status.clocks = data.clockInfo;
				this.addClockTypeText();
				this.fixClockTimeData();
				this.emit( 'clocksupdate' );
				break;
			case 'clockNameChanged':
				let index = data.clockIndex;
				if ( this.status.clocks[ index ] ) this.status.clocks[ index ].clockName = data.clockName;
				this.emit( 'clocksupdate' );
				break;
			case 'clockCurrentTimes':
				let didchange = false;
				if ( this.status.clocks.length > 0 ) {
					for ( let i = 0; i < data.clockTimes.length; i++ ) {
						if ( this.status.clocks[ i ] ) {
							if ( this.status.clocks[ i ].clockTime != data.clockTimes[ i ] ) {
								this.status.clocks[ i ].clockTime = data.clockTimes[ i ];
								this.status.clocks[ i ].updated = true;
								didchange = true;
							} else {
								this.status.clocks[ i ].updated = false;
							}
						}
					}
				}
				if ( didchange ) {
					this.fixClockTimeData();
					this.emit( 'clocksupdate' );
				}
				break;
			case 'clockStartStop':
				let i = data.clockIndex;
				if ( this.status.clocks[ i ] ) {
					let clock = this.status.clocks[ i ];
					// I'm ignoring data.clockInfo because we don't know what the three items are
					clock.clockState = data.clockState == 1; // reported as int for some reason
					clock.clockTime = data.clockTime;
				}
				this.emit( 'clocksupdate' );
				break;
			default:
				break;
		}

		// handle update stream
		this.emit( 'data', data, this );

		// handle callbacks
		if ( typeof this.callbacks[ data.action ] == 'function' ) {
			this.callbacks[ data.action ]( data );
			delete this.callbacks[ data.action ];
		}
	}

	addClockTypeText() {
		let types = [ 'Countdown', 'Countdown To Time', 'Elapsed Time' ];
		for ( let c of this.status.clocks ) {
			c.clockTypeText = types[ c.clockType ];
		}
	}
	fixClockTimeData() {
		for ( let c of this.status.clocks ) {
			c.text = c.clockTime;
			c.seconds = hms2secs( c.clockTime );
			c.over = c.seconds < 0;
			c.running = c.clockState;
		}
	}

	action( action, callback = null ) {
		this.send( { action }, callback );
	}

	startClock( clockIndex, callback = null ) {
		this.send( { action: "clockStart", clockIndex }, callback );
	}

	stopClock( clockIndex, callback = null ) {
		this.send( { action: "clockStop", clockIndex }, callback );
	}

	resetClock( clockIndex, callback = null ) {
		this.send( { action: "clockReset", clockIndex }, callback );
	}

	subscribeClocks( callback = null ) {
		this.action( 'clockStartSendingCurrentTime', callback );
	}

	unsubscribeClocks( callback = null ) {
		this.action( 'clockStopSendingCurrentTime', callback );
	}

	getClocks( callback = null ) {
		this.action( 'clockRequest', callback );
	}

	getLibrary( callback = null ) {
		this.action( 'libraryRequest', callback );
	}

	getPlaylists( callback = null ) {
		this.action( 'playlistRequestAll', callback );
	}

	getPresentation( path = null, quality = 200, callback = null ) {
		if ( path == null ) {
			this.send(
				{
					action: 'presentationCurrent',
					presentationSlideQuality: quality,
				},
				callback
			);
		} else {
			this.send(
				{
					action: 'presentationRequest',
					presentationPath: path,
					presentationSlideQuality: quality,
				},
				callback
			);
		}
	}

	getCurrentSlideIndex( callback = null ) {
		this.action( 'presentationSlideIndex', callback );
	}

	triggerSlide( index = 0, path = null, callback = null ) {
		if ( !this.controlling ) return false;
		if ( path == null && this.status.currentPresentation == null ) return false;
		if ( path == null )
			path = this.status.currentPresentation.presentationCurrentLocation;
		this.send(
			{
				action: 'presentationTriggerIndex',
				slideIndex: index,
				presentationPath: path,
			},
			callback
		);
		return true;
	}

	next( callback = null ) {
		if ( this.status.currentPresentation == null ) return false;
		if ( this.status.currentSlideIndex == null ) return false;
		let nextIndex = this.status.currentSlideIndex + 1;
		return this.triggerSlide( nextIndex, null, callback );
	}

	prev( callback = null ) {
		if ( this.status.currentPresentation == null ) return false;
		if ( this.status.currentSlideIndex == null ) return false;
		let nextIndex = this.status.currentSlideIndex - 1;
		if ( nextIndex < 0 ) nextIndex = 0;
		return this.triggerSlide( nextIndex, null, callback );
	}
}

exports.ProSDClient = ProSDClient;
exports.ProRemoteClient = ProRemoteClient;
