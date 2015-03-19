mcprotocol
==========

mcprotocol is a library that allows communication to Mitsubishi PLCs (currently only FX3U tested) using the MC (MELSEC Communication) Ethernet protocol as documented by Mitsubishi. 

This software is not affiliated with Mitsubishi in any way, nor am I.  FX3U and MELSEC are trademarks of Mitsubishi.

WARNING - This is BETA CODE and you need to be aware that WRONG VALUES could be written to WRONG LOCATIONS.  Fully test everything you do.  In situations where writing to a random area of memory within the PLC could cost you money, back up your data and test this really well.  If this could injure someone or worse, consider other software.

It is optimized - it sorts a large number of items being requested from the PLC and decides what overall data areas to request, then it groups multiple small requests together in a single packet or number of packets up to the maximum length the protocol supports.   So a request for 100 different bits, all close (but not necessarily completely contiguous) will be grouped in one single request to the PLC, with no additional direction from the user.

mcprotocol manages reconnects for you.  So if the connection is lost because the PLC is powered down or disconnected, you can continue to request data with no other action necessary.  "Bad" values are returned, and eventually the connection will be automatically restored.

mcprotocol is written entirely in JavaScript, so no compiler or Python installation is necessary on Windows, and deployment on other platforms (ARM, etc) should be trivial.

Either ASCII or binary communication is supported.  Binary communication is the default, as it is faster as less data is actually sent.

This has been tested only on direct connection to FX3U-ENET and FX3U-ENET-ADP.  The Q-series E71 appears to support the same frames and should (in theory) work, but other PLCs are not supported.  Serial port access is not supported either - the protocol is slightly different.  This only sends and receives "A compatible 1E frames". 

UDP connections are not currently possible.

To configure a compatible connection on your FX with an FX3U-ENET, create a connection in the list (in FX-Configurator-EN for FX3U-ENET or GXWorks2 PLC Parameter for FX3U-ENET-ADP), Protocol "TCP", Open System "Unpassive", (Fixed buffer can be send or receive if using a FX3U-ENET), Fixed Buffer Communication Procedure set to "Procedure Exist (MC)", "Pairing Open" set to "Disable", Existence Confirmation set to "Confirm" (No Confirm works as well, but can keep connections open for a long time causing failed reconnects) and "Port" set to a value that is the same as what you set when you initiate the connection from node.js.

With an FX3U-ENET-ADP the process is simpler - in GXWorks2, under PLC Parameter, Ethernet Setting, Open Setting, make sure one of the connections is set up as "TCP", "MC Protocol" and a matching port. 

To get started:

	npm install mcprotocol

Example usage:

	var mc = require('mcprotocol');
	var conn = new mc;
	var doneReading = false;
	var doneWriting = false;

	var variables = { TEST1: 'D0,5', 	// 5 words starting at D0
		  TEST2: 'M6990,28', 			// 28 bits at M6990
		  TEST3: 'CN199,2',			// ILLEGAL as CN199 is 16-bit, CN200 is 32-bit, must request separately
		  TEST4: 'R2000,2',			// 2 words at R2000
		  TEST5: 'X034',				// Simple input
		  TEST6: 'D6000.1,20',			// 20 bits starting at D6000.1
		  TEST7: 'D6001.2',				// Single bit at D6001
		  TEST8: 'S4,2',				// 2 bits at S4
		  TEST9: 'RFLOAT5000,40'		// 40 floating point numbers at R5000	
	};										// See setTranslationCB below for more examples

	conn.initiateConnection({port: 1281, host: '192.168.0.2', ascii: false}, connected); 

	function connected(err) {
		if (typeof(err) !== "undefined") {
			// We have an error.  Maybe the PLC is not reachable.  
			console.log(err);
			process.exit();
		}
		conn.setTranslationCB(function(tag) {return variables[tag];}); 	// This sets the "translation" to allow us to work with object names defined in our app not in the module
		conn.addItems(['TEST1', 'TEST4']);	
		conn.addItems('TEST6');
	//	conn.removeItems(['TEST2', 'TEST3']);  // We could do this.  
	//	conn.writeItems(['TEST5', 'TEST7'], [ true, true ], valuesWritten);  	// You can write an array of items as well.  
		conn.writeItems('TEST4', [ 666, 777 ], valuesWritten);  				// You can write a single array item too.  
		conn.readAllItems(valuesReady);	
	}

	function valuesReady(anythingBad, values) {
		if (anythingBad) { console.log("SOMETHING WENT WRONG READING VALUES!!!!"); }
		console.log(values);
		doneReading = true;
		if (doneWriting) { process.exit(); }
	}

	function valuesWritten(anythingBad) {
		if (anythingBad) { console.log("SOMETHING WENT WRONG WRITING VALUES!!!!"); }
		console.log("Done writing.");
		doneWriting = true;
		if (doneReading) { process.exit(); }
	}


This produces the following output, excluding some logs from mcprotocol.js itself:
	
	Done writing.
	{ TEST1: [ 0, 0, 0, 0, 0 ],
	TEST6:
	[ true,
	     false,
	     true,
	     false,
	     false,
	     true,
	     false,
	     false,
	     false,
	     false,
	     false,
	     false,
	     false,
	     true,
	     false,
	     true,
	     true,
	     false,
	     true,
	     true ],
	  TEST4: [ 666, 777 ] }
	
	
	
### API
 - [initiateConnection()](#initiate-connection)
 - [dropConnection()](#drop-connection)
 - [setTranslationCB()](#set-translation-cb)
 - [addItems()](#add-items)
 - [removeItems()](#remove-items)
 - [writeItems()](#write-items)
 - [readAllItems()](#read-all-items)


#### <a name="initiate-connection"></a>mcprotocol.initiateConnection(params, callback)
Connects to a PLC.  

params should be an object with the following keys:
- port (must match setting in configurator - note this is for TCP connections only, see other setup suggestions above)
- host (ip address or host name)
- ascii (default false, set to true if you have set this setting this way in the configurator for the Ethernet module)
- octalInputOutput (default true, set to false if you really don't like the fact that the program converts Xxxx and Yxxx addresses from Octal to Decimal, ensure you connect before you add items if you're going to set this to false)  If left at the default, addresses line up with GXWorks/GXDeveloper.

`callback(err)` will be executed on success or failure.  err is either an error object, or undefined on successful connection.

#### <a name="drop-connection"></a>mcprotocol.dropConnection()
Disconnects from a PLC.  

This simply terminates the TCP connection.


#### <a name="set-translation-cb"></a>mcprotocol.setTranslationCB(translator)
Sets a callback for name - address translation.  

This is optional - you can choose to use "addItem" etc with absolute addresses.

If you use it, `translator` should be a function that takes a string as an argument, and returns a string in the following format:
- <memory area>[type modifier]<device offset><.bit offset><,array length>
- Examples:
- M100,20 - 20 boolean values starting at M100, ending at M119
- X0,8 - First 8 inputs
- TS190 - Status of timer 290 (boolean)
- TN190 - Elapsed time value of timer 290 (integer)
- CS190 - Status of counter 190 
- CN220 - Count value (double integer as it's over 200)
- DFLOAT1000 - Floating point value starting at D1000 (and including D1001 as float takes 2 words)
- D2000,5 - 5 values starting at D2000
- RDINT80 - R80 and R81 as a DINT
- RSTR30,10 - String that is 10 characters (5 words) starting at R30
- S5 - Boolean at S5
- RFLOAT20,5 - Floating point values starting at R20-21 and ending R28-29
- Y010 - Output at Y010 (actually the 9th output as outputs are in order Y000-Y008 then Y010)
- D1000.2 - Bit 2 of word D1000
- D1000.2,5 - 5 bits starting at D1000.2

In the example above, an object is declared and the `translator` references that object.  It could just as reference a file or database.  In any case, it allows cleaner Javascript code to be written that refers to a name instead of an absolute address.  


#### <a name="add-items"></a>mcprotocol.addItems(items)
Adds `items` to the internal read polling list.  

`items` can be a string or an array of strings.

#### <a name="remove-items"></a>mcprotocol.removeItems(items)
Removes `items` to the internal read polling list.  

`items` can be a string or an array of strings.

#### <a name="write-items"></a>mcprotocol.writeItems(items, values)
Writes `items` to the PLC using the corresponding `values`.  

`items` can be a string or an array of strings.  If `items` is a single string, `values` should then be a single item (or an array if `items` is an array item).  If `items` is an array of strings, `values` must be an array.


#### <a name="read-all-items"></a>mcprotocol.readAllItems(callback)
Reads the internal polling list and calls `callback` when done.  

`callback(err, values)` is called with two arguments - a boolean indicating if ANY of the items have "bad quality", and `values`, an object containing the values being read as keys and their value (from the PLC) as the value.



