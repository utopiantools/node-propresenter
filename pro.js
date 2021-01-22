const P6_SD_PROTO = 610
const P6_CONTROL_PROTO = 600
const P7_SD_PROTO = 710
const P7_CONTROL_PROTO = 700

// WS module doesn't work in browsers
const WebSocket = require( "ws" );

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


class Slide {
	constructor () {
		this.uid = "";
		this.text = "";
		this.notes = "";
	}
}

// listens to ProPresenter
// as a stage display client
class ProStageClient {
	constructor ( host, password, options ) {
		// instance variables
		this.connected = false;
		this.active = false;
		this.debug = false;

		// status variables
		this.stage_message = "";
		this.system_time = { text: "", seconds: 0 };
		this.timers = {};
		this.slides = {
			current: new Slide(),
			next: new Slide(),
		};

		// configuration
		this.host = host;
		this.password = password;
		this.protocol = options.version == 6 ? P6_SD_PROTO : P7_SD_PROTO;

		// callbacks
		this.ondata = options.ondata;
		this.onupdate = options.onupdate;
		this.onmsgupdate = options.onmsgupdate;
		this.onsysupdate = options.onsysupdate;
		this.onslideupdate = options.onslideupdate;
		this.ontimersupdate = options.ontimersupdate;

		this.connect();
	}

	_debug( s ) {
		if ( this.debug ) console.log( s );
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

	reconnect( delay = 0 ) {
		this._debug( `Attempting reconnect in ${delay} seconds.` );
		clearTimeout( this.reconnectTimeout );
		this.reconnectTimeout = setTimeout( () => {
			this.connect();
		}, delay * 1000 );
	}

	connect() {
		this.connected = false;
		this.active = false;

		clearTimeout( this.reconnectTimeout );

		if ( this.ws ) this.ws.terminate();
		this.ws = new WebSocket( `ws://${this.host}/stagedisplay` );

		this.ws.on( "error", ( err ) => {
			this._debug( "ProPresenter WebSocket Error:" );
			// debug(err);
			this.ws.terminate();
			this.reconnect( 30 );
		} );

		this.ws.on( "message", ( data ) => {
			this.check( JSON.parse( data ) );
		} );

		this.ws.on( "open", () => {
			this.connected = true;
			this.authenticate();
		} );

		this.ws.on( "close", () => {
			// this.ws.terminate();
			this.reconnect( 10 );
			this.connected = false;
			this.active = false;
		} );
	}

	send( Obj ) {
		this.ws.send( JSON.stringify( Obj ) );
	}

	authenticate() {
		let auth = {
			pwd: this.password,
			ptl: this.protocol,
			acn: "ath",
		};
		this.send( auth );
	}

	check( data ) {
		// debug( data );
		let newdata = {};
		switch ( data.acn ) {
			case "ath":
				//{"acn":"ath","ath":true/false,"err":""}
				if ( data.ath ) {
					this._debug( "ProPresenter Listener is Connected" );
					this.active = true;
					newdata = { type: "authentication", data: true };
				} else {
					this.connected = false;
					this.active = false;
					newdata = { type: "authentication", data: false };
				}
				break;
			case "tmr":
				this.timers[ data.uid ] = { uid: data.uid, text: data.txt, seconds: hms2secs( data.txt ) };
				newdata = { type: "timer", data: this.timers[ data.uid ] };
				if ( this.ontimersupdate ) this.ontimersupdate( this.timers[ data.uid ] );
				break;
			case "sys":
				// { "acn": "sys", "txt": " 11:17 AM" }
				this.system_time = { text: data.txt, seconds: timestring2secs( data.txt ) };
				newdata = { type: "systime", data: this.system_time };
				if ( this.onsysupdate ) this.onsysupdate( this.system_time );
				break;
			case "msg":
				// { acn: 'msg', txt: 'Test' }
				this.stage_message = data.txt;
				newdata = { type: "message", data: this.stage_message };
				if ( this.onmsgupdate ) this.onmsgupdate( this.stage_message );
				break;
			case "fv":
				// we expect 4 items identified by the 'acn' field
				// cs: current slide
				// csn: current slide notes
				// ns: next slide
				// nsn: next slide notes

				this.slides.current = new Slide();
				this.slides.next = new Slide();
				for ( let blob of data.ary ) {
					switch ( blob.acn ) {
						case "cs":
							this.slides.current.uid = blob.uid;
							this.slides.current.text = blob.txt;
							break;
						case "csn":
							this.slides.current.notes = blob.txt;
							break;
						case "ns":
							this.slides.next.uid = blob.uid;
							this.slides.next.text = blob.txt;
							break;
						case "nsn":
							this.slides.next.notes = blob.txt;
							break;
					}
				}
				newdata = { type: "slides", data: this.slides };
				if ( this.onslideupdate ) this.onslideupdate( this.slides );
		}
		if ( this.ondata ) this.ondata( data );
		if ( this.onupdate ) this.onupdate( newdata, this );
	}
}

// incomplete at the moment
class ProControlClient {
	constructor ( host, password, options ) {
		// instance variables
		this.connected = false;
		this.controlling = false;
		this.debug = false;

		// callbacks for internal use only to handle command replies
		this._callbacks = {};

		this.host = host;
		this.password = password;
		this.protocol = options.version == 6 ? P6_CONTROL_PROTO : P7_CONTROL_PROTO;
		this.ondata = options.ondata;
		this.onupdate = options.onupdate;

		// handle pro6 status
		this.currentPresentation = null;
		this.currentSlideIndex = 0;
		this.library = [];
		this.playlists = [];

		this.connect();
	}

	status() {
		return {
			currentPresentation: this.currentPresentation,
			currentSlideIndex: this.currentSlideIndex,
			library: this.library,
			playlists: this.playlists,
			connected: this.connected,
			controlling: this.controlling,
		}
	}

	connect() {
		this.ws = new WebSocket( `ws://${this.host}/remote` );

		this.ws.on( "message", ( data ) => {
			this.handleData( JSON.parse( data ) );
		} );
		this.ws.on( "open", () => {
			this.authenticate();
		} );
		this.ws.on( "close", () => {
			this.connected = false;
			this.controlling = false;
		} );
	}

	_debug( s ) {
		if ( this.debug ) console.log( s );
	}

	send( Obj, callback = null ) {
		// register callback if there is one.
		if ( typeof callback == "function" ) {
			// fix api bug
			let responseAction = Obj.action;
			if ( Obj.action == "presentationRequest" ) responseAction = "presentationCurrent";
			this._callbacks[ responseAction ] = callback;
		}
		let data = JSON.stringify( Obj );
		this._debug( 'SENDING DATA:' );
		this._debug( data );
		this.ws.send( data );
	}

	authenticate() {
		let auth = {
			password: this.password,
			protocol: this.protocol,
			action: "authenticate",
		};
		this.send( auth );
	}

	flattenedPlaylists() {
		let retval = [];
		for ( let playlistObj of this.playlists ) {
			retval.push( ... this.flattenPlaylist( playlistObj ) );
		}
		return retval;
	}

	flattenPlaylist( playlistObj ) {
		let flattened = [];

		switch ( playlistObj.playlistType ) {
			case "playlistTypePlaylist":
				flattened = playlistObj.playlist;
				break;
			case "playlistTypeGroup":
				for ( let playlist of playlistObj.playlist ) {
					flattened.push( ...this.flattenPlaylist( playlist ) );
				}
				break;
		}
		return flattened;
	}

	loadStatus() {
		this.getLibrary();
		this.getPlaylists();
		this.getPresentation();
		this.getCurrentSlideIndex();
	}

	handleData( data ) {
		// debug( data );

		// process data for this class instance
		switch ( data.action ) {
			case "authenticate":
				if ( data.authenticated == 1 ) this.connected = true;
				if ( data.controller == 1 ) this.controlling = true;

				if ( this.connected ) this.loadStatus();
				break;
			case "libraryRequest":
				this.library = data.library;
				break;
			case "playlistRequestAll":
				this.playlists = data.playlistAll;
				break;
			case "presentationCurrent":
				this.currentPresentation = data.presentation;
				break;
			case "presentationSlideIndex":
				this.currentSlideIndex = +data.slideIndex;
				break;
			case "presentationTriggerIndex":
				this.currentSlideIndex = +data.slideIndex;
				if ( this.currentPresentation == null ) {
					this.getPresentation();
				}
		}

		// handle update stream
		if ( this.ondata ) this.ondata( data );
		if ( this.onupdate ) this.onupdate( data, this );

		// handle callbacks
		if ( typeof this._callbacks[ data.action ] == "function" ) {
			this._callbacks[ data.action ]( data );
			delete this._callbacks[ data.action ];
		}
	}

	getLibrary( callback = null ) {
		this.send( { action: "libraryRequest" }, callback );
	}

	getPlaylists( callback = null ) {
		this.send( { action: "playlistRequestAll" }, callback );
	}

	getPresentation( path = null, quality = 10, callback = null ) {
		if ( path == null ) {
			this.send(
				{
					action: "presentationCurrent",
					presentationSlideQuality: quality,
				},
				callback
			);
		} else {
			this.send(
				{
					action: "presentationRequest",
					presentationPath: path,
					presentationSlideQuality: quality,
				},
				callback
			);
		}
	}

	getCurrentSlideIndex( callback = null ) {
		this.send( { action: "presentationSlideIndex" }, callback );
	}

	triggerSlide( index = 0, path = null, callback = null ) {
		if ( !this.controlling ) return false;
		if ( path == null && this.currentPresentation == null ) return false;
		if ( path == null ) path = this.currentPresentation.presentationCurrentLocation;
		this.send(
			{
				action: "presentationTriggerIndex",
				slideIndex: index.toString(),
				presentationPath: path,
			},
			callback
		);
		return true;
	}

	next( callback = null ) {
		if ( this.currentPresentation == null ) return false;
		if ( this.currentSlideIndex == null ) return false;
		let nextIndex = this.currentSlideIndex + 1;
		return this.triggerSlide( nextIndex, null, callback );
	}

	prev( callback = null ) {
		if ( this.currentPresentation == null ) return false;
		if ( this.currentSlideIndex == null ) return false;
		let nextIndex = this.currentSlideIndex - 1;
		if ( nextIndex < 0 ) nextIndex = 0;
		return this.triggerSlide( nextIndex, null, callback );
	}
}

exports.ProStageClient = ProStageClient;
exports.ProControlClient = ProControlClient;
