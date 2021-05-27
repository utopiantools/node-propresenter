const { ProSDClient, ProRemoteClient } = require( './pro' );

const sd = new ProSDClient( 'localhost', 60157, 'av', 7 );
const remote = new ProRemoteClient( 'localhost', 60157, 'control', 7 );

sd.on( 'update', console.log );
remote.on( 'update', console.log );


sd.connect();
remote.connect();
