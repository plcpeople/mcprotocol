// MCPROTOCOL - A library for communication to Mitsubishi PLCs over Ethernet from node.js. 
// Currently only FX3U CPUs using FX3U-ENET and FX3U-ENET-ADP modules (Ethernet modules) tested.
// Please report experiences with others.

// The MIT License (MIT)

// Copyright (c) 2015 Dana Moffit

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// EXTRA WARNING - This is BETA software and as such, be careful, especially when 
// writing values to programmable controllers.
//
// Some actions or errors involving programmable controllers can cause injury or death, 
// and YOU are indicating that you understand the risks, including the 
// possibility that the wrong address will be overwritten with the wrong value, 
// when using this library.  Test thoroughly in a laboratory environment.

var net = require("net");
var _ = require("underscore");
var util = require("util");
var effectiveDebugLevel = 0; // intentionally global, shared between connections
var monitoringTime = 10;

module.exports = MCProtocol;

function MCProtocol(){
	var self = this;
												
	self.readReq = new Buffer(1500);
	self.writeReq = new Buffer(1500);

	self.resetPending = false;
	self.resetTimeout = undefined;

	self.maxPDU = 255;
	self.isoclient = undefined; 
	self.isoConnectionState = 0;
	self.requestMaxParallel = 1;
	self.maxParallel = 1;				// MC protocol is read/response.  Parallel jobs not supported.
	self.isAscii = 1;
	self.octalInputOutput;
	self.parallelJobsNow = 0;
	self.maxGap = 5;
	self.doNotOptimize = false;
	self.connectCallback = undefined;
	self.readDoneCallback = undefined;
	self.writeDoneCallback = undefined;
	self.connectTimeout = undefined; 
	self.PDUTimeout = undefined;
	self.globalTimeout = 4500;

	self.readPacketArray = [];
	self.writePacketArray = [];
	self.polledReadBlockList = [];
	self.instantWriteBlockList = [];
	self.globalReadBlockList = [];
	self.globalWriteBlockList = [];
	self.masterSequenceNumber = 1;
	self.translationCB = doNothing;
	self.connectionParams = undefined;
	self.connectionID = 'UNDEF';
	self.addRemoveArray = [];
	self.readPacketValid = false;
	self.writeInQueue = false;
	self.connectCBIssued = false;
}

MCProtocol.prototype.setTranslationCB = function(cb) {
	var self = this;
	if (typeof cb === "function") { 
		outputLog('Translation OK');
		self.translationCB = cb; 
	}
}

MCProtocol.prototype.initiateConnection = function (cParam, callback) {
	var self = this;
	if (cParam === undefined) { cParam = {port: 10000, host: '192.168.8.106', ascii: false}; }
	outputLog('Initiate Called - Connecting to PLC with address and parameters:');
	outputLog(cParam);
	if (typeof(cParam.name) === 'undefined') {
		self.connectionID = cParam.host;
	} else {
		self.connectionID = cParam.name;		
	}
	if (typeof(cParam.ascii) === 'undefined') {
		self.isAscii = false;
	} else {
		self.isAscii = cParam.ascii;		
	}
	if (typeof(cParam.octalInputOutput) === 'undefined') {
		self.octalInputOutput = true;
	} else {
		self.octalInputOutput = cParam.octalInputOutput;		
	}	
	self.connectionParams = cParam;
	self.connectCallback = callback;
	self.connectCBIssued = false;
	self.connectNow(self.connectionParams, false);
}

MCProtocol.prototype.dropConnection = function () {
	var self = this;
	if (typeof(self.isoclient) !== 'undefined') {
		self.isoclient.end();
	}		
	self.connectionCleanup();  // TODO - check this.
}

MCProtocol.prototype.connectNow = function(cParam, suppressCallback) { // TODO - implement or remove suppressCallback
	var self = this;
	// Don't re-trigger.
	if (self.isoConnectionState >= 1) { return; }
	self.connectionCleanup();
	self.isoclient = net.connect(cParam, function(){
		self.onTCPConnect.apply(self,arguments);
	});
	
	self.isoclient.setKeepAlive(true,2500); // For reliable unplug detection in most cases - although it takes 10 minutes to notify
	self.isoConnectionState = 1;  // 1 = trying to connect
    
	self.isoclient.on('error', function(){
		self.connectError.apply(self, arguments);
	});
	
	outputLog('<initiating a new connection>',1,self.connectionID);  
	outputLog('Attempting to connect to host...',0,self.connectionID);
}

MCProtocol.prototype.connectError = function(e) {
	var self = this;
	
	// Note that a TCP connection timeout error will appear here.  An MC connection timeout error is a packet timeout.  
	outputLog('We Caught a connect error ' + e.code,0,self.connectionID);
	if ((!self.connectCBIssued) && (typeof(self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback(e);
	}
	self.isoConnectionState = 0;
}

MCProtocol.prototype.readWriteError = function(e) {
	var self = this;
	outputLog('We Caught a read/write error ' + e.code + ' - resetting connection',0,self.connectionID);
	self.isoConnectionState = 0;
	self.connectionReset();
}

MCProtocol.prototype.packetTimeout = function(packetType, packetSeqNum) {
	var self = this;
	outputLog('PacketTimeout called with type ' + packetType + ' and seq ' + packetSeqNum,1,self.connectionID); 
	if (packetType === "read") {
		outputLog("READ TIMEOUT on sequence number " + packetSeqNum,0,self.connectionID);
		self.readResponse(undefined); //, self.findReadIndexOfSeqNum(packetSeqNum));
		return undefined;
	}
	if (packetType === "write") {
		outputLog("WRITE TIMEOUT on sequence number " + packetSeqNum,0,self.connectionID);
		self.writeResponse(undefined); //, self.findWriteIndexOfSeqNum(packetSeqNum));
		return undefined;
	}	
	outputLog("Unknown timeout error.  Nothing was done - this shouldn't happen.",0,self.connectionID);
}

MCProtocol.prototype.onTCPConnect = function() {
	var self = this;
	outputLog('TCP Connection Established to ' + self.isoclient.remoteAddress + ' on port ' + self.isoclient.remotePort,0,self.connectionID);

	// Track the connection state
	self.isoConnectionState = 4;  // 4 = all connected, simple with MC protocol.  Other protocols have a negotiation/session packet as well.
		
	self.isoclient.removeAllListeners('data');
	self.isoclient.removeAllListeners('error');
	
	self.isoclient.on('data', function() {
		self.onResponse.apply(self, arguments);
	});  // We need to make sure we don't add this event every time if we call it on data.  
	self.isoclient.on('error', function() {
		self.readWriteError.apply(self, arguments);
	});  // Might want to remove the connecterror listener

	if ((!self.connectCBIssued) && (typeof(self.connectCallback) === "function")) {
		self.connectCBIssued = true;
		self.connectCallback();
	}

	return;
}

MCProtocol.prototype.writeItems = function(arg, value, cb) {
	var self = this;
	var i;
	outputLog("Preparing to WRITE " + arg,0,self.connectionID);

	if (self.isWriting()) {
		outputLog("You must wait until all previous writes have finished before scheduling another. ",0,self.connectionID); 
		return; 
	}
	
	if (typeof cb === "function") {
		self.writeDoneCallback = cb;
	} else {
		self.writeDoneCallback = doNothing;
	}
	
	self.instantWriteBlockList = []; // Initialize the array.  
	
	if (typeof arg === "string") { 
		self.instantWriteBlockList.push(stringToMCAddr(self.translationCB(arg), arg, self.octalInputOutput));
		if (typeof(self.instantWriteBlockList[self.instantWriteBlockList.length - 1]) !== "undefined") {
			self.instantWriteBlockList[self.instantWriteBlockList.length - 1].writeValue = value;
		}
	} else if (_.isArray(arg) && _.isArray(value) && (arg.length == value.length)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof arg[i] === "string") {
				self.instantWriteBlockList.push(stringToMCAddr(self.translationCB(arg[i]), arg[i], self.octalInputOutput));
				if (typeof(self.instantWriteBlockList[self.instantWriteBlockList.length - 1]) !== "undefined") {
					self.instantWriteBlockList[self.instantWriteBlockList.length - 1].writeValue = value[i];
				}				
			}
		}
	}
	
	// Validity check.  
	for (i=self.instantWriteBlockList.length-1;i>=0;i--) {
		if (self.instantWriteBlockList[i] === undefined) {
			self.instantWriteBlockList.splice(i,1);
			outputLog("Dropping an undefined write item.");
		}
	}
	self.prepareWritePacket();
	if (!self.isReading()) { 
		self.sendWritePacket(); 
	} else {
		self.writeInQueue = true;
	}
}

MCProtocol.prototype.findItem = function(useraddr) {
	var self = this;
	var i;
	var commstate = { value: self.isoConnectionState !== 4, quality: 'OK' };
	if (useraddr === '_COMMERR') { return commstate; }
	for (i = 0; i < self.polledReadBlockList.length; i++) {
		if (self.polledReadBlockList[i].useraddr === useraddr) { return self.polledReadBlockList[i]; } 
	}
	return undefined;
}

MCProtocol.prototype.addItems = function(arg) {
	var self = this;
	self.addRemoveArray.push({arg: arg, action: 'add'});
}

MCProtocol.prototype.addItemsNow = function(arg) {
	var self = this;
	var i;
	outputLog("Adding " + arg,0,self.connectionID);
	addItemsFlag = false;
	if (typeof arg === "string" && arg !== "_COMMERR") { 
		self.polledReadBlockList.push(stringToMCAddr(self.translationCB(arg), arg, self.octalInputOutput));
	} else if (_.isArray(arg)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof arg[i] === "string" && arg[i] !== "_COMMERR") {
				self.polledReadBlockList.push(stringToMCAddr(self.translationCB(arg[i]), arg[i], self.octalInputOutput));
			}
		}
	}
	
	// Validity check.  
	for (i=self.polledReadBlockList.length-1;i>=0;i--) {
		if (self.polledReadBlockList[i] === undefined) {
			self.polledReadBlockList.splice(i,1);
			outputLog("Dropping an undefined request item.");
		}
	}
//	prepareReadPacket();
	self.readPacketValid = false;
}

MCProtocol.prototype.removeItems = function(arg) {
	var self = this;
	self.addRemoveArray.push({arg : arg, action: 'remove'});
}

MCProtocol.prototype.removeItemsNow = function(arg) {
	var self = this;
	var i;
	self.removeItemsFlag = false;
	if (typeof arg === "undefined") {
		self.polledReadBlockList = [];
	} else if (typeof arg === "string") {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			outputLog('TCBA ' + self.translationCB(arg));
			if (self.polledReadBlockList[i].addr === self.translationCB(arg)) {
				outputLog('Splicing');
				self.polledReadBlockList.splice(i, 1);
			}
		}
	} else if (_.isArray(arg)) {
		for (i = 0; i < self.polledReadBlockList.length; i++) {
			for (j = 0; j < arg.length; j++) {
				if (self.polledReadBlockList[i].addr === self.translationCB(arg[j])) {
					self.polledReadBlockList.splice(i, 1);
				}
			}
		}
	}
	self.readPacketValid = false;
	//	prepareReadPacket();
}

MCProtocol.prototype.readAllItems = function(arg) {
	var self = this;
	var i;

	outputLog("Reading All Items (readAllItems was called)",1,self.connectionID);
	
	if (typeof arg === "function") {
		self.readDoneCallback = arg;
	} else {
		self.readDoneCallback = doNothing;
	}	
	
	if (self.isoConnectionState !== 4) { 
		outputLog("Unable to read when not connected. Return bad values.",0,self.connectionID);
	} // For better behaviour when auto-reconnecting - don't return now
	
	// Check if ALL are done...  You might think we could look at parallel jobs, and for the most part we can, but if one just finished and we end up here before starting another, it's bad.
	if (self.isWaiting()) { 
		outputLog("Waiting to read for all R/W operations to complete.  Will re-trigger readAllItems in 100ms."); 
		setTimeout(function() {
			self.readAllItems.apply(self, arguments);
		}, 100, arg); 
		return;
	}
	
	// Now we check the array of adding and removing things.  Only now is it really safe to do this.  
	self.addRemoveArray.forEach(function(element){
		outputLog('Adding or Removing ' + util.format(element), 1, self.connectionID);
		if (element.action === 'remove') {
			self.removeItemsNow(element.arg);
		} 
		if (element.action === 'add') {
			self.addItemsNow(element.arg);
		}
	});
	
	self.addRemoveArray = []; // Clear for next time.  
	
	if (!self.readPacketValid) { self.prepareReadPacket(); }
	
	// ideally...  incrementSequenceNumbers();
	
	outputLog("Calling SRP from RAI",1,self.connectionID);
	self.sendReadPacket(); // Note this sends the first few read packets depending on parallel connection restrictions.   
}

MCProtocol.prototype.isWaiting = function() {
	var self = this;
	return (self.isReading() || self.isWriting());
}

MCProtocol.prototype.isReading = function() {
	var self = this;
	var i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i=0; i<self.readPacketArray.length; i++) {
		if (self.readPacketArray[i].sent === true) { return true };  
	}
	return false;
}

MCProtocol.prototype.isWriting = function() {
	var self = this;
	var i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i=0; i<self.writePacketArray.length; i++) {
		if (self.writePacketArray[i].sent === true) { return true }; 
	}	
	return false;
}


MCProtocol.prototype.clearReadPacketTimeouts = function() {
	var self = this;
	outputLog('Clearing read PacketTimeouts',1,self.connectionID);
	// Before we initialize the readPacketArray, we need to loop through all of them and clear timeouts.  
	for (i=0;i<self.readPacketArray.length;i++) {
		clearTimeout(self.readPacketArray[i].timeout);
		self.readPacketArray[i].sent = false;
		self.readPacketArray[i].rcvd = false;
	}
}

MCProtocol.prototype.clearWritePacketTimeouts = function() {
	var self = this;
	outputLog('Clearing write PacketTimeouts',1,self.connectionID);
	// Before we initialize the readPacketArray, we need to loop through all of them and clear timeouts.  
	for (i=0;i<self.writePacketArray.length;i++) {
		clearTimeout(self.writePacketArray[i].timeout);
		self.writePacketArray[i].sent = false;
		self.writePacketArray[i].rcvd = false;
	}
}

MCProtocol.prototype.prepareWritePacket = function() {
	var self = this;
	var itemList = self.instantWriteBlockList;
	var requestList = [];			// The request list consists of the block list, split into chunks readable by PDU.  
	var requestNumber = 0;
	var itemsThisPacket;
	var numItems;
	
	// Sort the items using the sort function, by type and offset.  
	itemList.sort(itemListSorter);
	
	// Just exit if there are no items.  
	if (itemList.length == 0) {
		return undefined;
	}
	
	// At this time we do not do write optimizations.  
	// The reason for this is it is would cause numerous issues depending how the code was written in the PLC.
	// If we write B3:0/0 and B3:0/1 then to optimize we would have to write all of B3:0, which also writes /2, /3...
	//
	// I suppose when working with integers, we could write these as one block.  
	// But if you really, really want the program to do that, write the integer yourself.  
	self.globalWriteBlockList[0] = itemList[0];
	self.globalWriteBlockList[0].itemReference = [];
	self.globalWriteBlockList[0].itemReference.push(itemList[0]);
	
	var thisBlock = 0;
	var thisRequest = 0;
	
	itemList[0].block = thisBlock;
	
	// Just push the items into blocks and figure out the write buffers
	for (i=0;i<itemList.length;i++) {
		self.globalWriteBlockList[i] = itemList[i]; // Remember - by reference.  
		self.globalWriteBlockList[i].isOptimized = false;
		self.globalWriteBlockList[i].itemReference = [];
		self.globalWriteBlockList[i].itemReference.push(itemList[i]);
		bufferizeMCItem(itemList[i],self.isAscii);
	}
		
	// Split the blocks into requests, if they're too large.  
	for (i=0;i<self.globalWriteBlockList.length;i++) {
		var startElement = self.globalWriteBlockList[i].offset;
		var remainingLength = self.globalWriteBlockList[i].byteLengthWrite;
		var remainingTotalArrayLength = self.globalWriteBlockList[i].totalArrayLength;
		
		// With the MC protocol, maxByteRequest is variable.  
		// We also use maxByteRequest to enforce a boundary on reading counter values that we can't cross.
		var maxByteRequest = self.globalWriteBlockList[i].maxWordLength(true)*2; // Will be 10*2 = 20 for bit native.  (160 point max)

		var lengthOffset = 0;

		// Always create a request for a globalWriteBlockList. 
		requestList[thisRequest] = self.globalWriteBlockList[i].clone();
	
		// How many parts?
		self.globalWriteBlockList[i].parts = Math.ceil(self.globalWriteBlockList[i].byteLengthWrite/maxByteRequest); 
		outputLog("globalWriteBlockList " + i + " parts is " + self.globalWriteBlockList[i].parts + " offset is " + self.globalWriteBlockList[i].offset + " MBR is " + maxByteRequest,2);
		
		self.globalWriteBlockList[i].requestReference = [];
		
		// If we need to spread the sending/receiving over multiple packets...
		for (j=0;j<self.globalWriteBlockList[i].parts;j++) {
			requestList[thisRequest] = self.globalWriteBlockList[i].clone();
			self.globalWriteBlockList[i].requestReference.push(requestList[thisRequest]);
			requestList[thisRequest].offset = startElement;
			requestList[thisRequest].byteLengthWrite = Math.min(maxByteRequest,remainingLength);
			if(requestList[thisRequest].bitNative) {
				requestList[thisRequest].totalArrayLength = Math.min(maxByteRequest*2,remainingTotalArrayLength,self.globalWriteBlockList[i].totalArrayLength); 
			} else {
				// I think we should be dividing by dtypelen here
				requestList[thisRequest].totalArrayLength = Math.min(maxByteRequest/self.globalWriteBlockList[i].dtypelen,remainingLength/self.globalWriteBlockList[i].dtypelen,self.globalWriteBlockList[i].totalArrayLength); 
			}
			remainingTotalArrayLength -= requestList[thisRequest].totalArrayLength;
			requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].byteLengthWrite;
			requestList[thisRequest].writeBuffer = self.globalWriteBlockList[i].writeBuffer.slice(lengthOffset, lengthOffset + requestList[thisRequest].byteLengthWithFill);  
			requestList[thisRequest].writeQualityBuffer = self.globalWriteBlockList[i].writeQualityBuffer.slice(lengthOffset, lengthOffset + requestList[thisRequest].byteLengthWithFill);  
			lengthOffset += self.globalWriteBlockList[i].requestReference[j].byteLengthWrite;

			if (self.globalWriteBlockList[i].parts > 1) {
				requestList[thisRequest].datatype = 'BYTE';
				requestList[thisRequest].dtypelen = 1;
				if (requestList[thisRequest].bitNative) {
					requestList[thisRequest].arrayLength = requestList[thisRequest].totalArrayLength;//globalReadBlockList[thisBlock].byteLength;		
				} else {
					requestList[thisRequest].arrayLength = requestList[thisRequest].byteLengthWrite/2;//globalReadBlockList[thisBlock].byteLength;		
				}
			}
			remainingLength -= maxByteRequest;
			if (self.globalWriteBlockList[i].bitNative) {
				startElement += maxByteRequest*2; 
			} else {
				startElement += maxByteRequest/2; 
			}
			thisRequest++;
		}		
	}

	self.clearWritePacketTimeouts(); 	
	self.writePacketArray = [];

	// Before we initialize the writePacketArray, we need to loop through all of them and clear timeouts.  
	// The packetizer...

	while (requestNumber < requestList.length) {
		// Set up the read packet
		// Yes this is the same master sequence number shared with the read queue
		self.masterSequenceNumber += 1;
		if (self.masterSequenceNumber > 32767) {
			self.masterSequenceNumber = 1;
		}
		
		numItems = 0;
		
		// Packet's length 
		var packetWriteLength = 10 + 4;  // 10 byte header and 4 byte param header 
			
		self.writePacketArray.push(new PLCPacket());
		var thisPacketNumber = self.writePacketArray.length - 1;
		self.writePacketArray[thisPacketNumber].seqNum = self.masterSequenceNumber;
	
		self.writePacketArray[thisPacketNumber].itemList = [];  // Initialize as array.  
	
		for (var i = requestNumber; i < requestList.length; i++) {

			if (numItems == 1) {
				break;  // Used to break when packet was full.  Now break when we can't fit this packet in here.  
			}

			requestNumber++;
			numItems++;
			packetWriteLength += (requestList[i].byteLengthWithFill + 4);
			self.writePacketArray[thisPacketNumber].itemList.push(requestList[i]);			
		}
	}
	outputLog("WPAL is " + self.writePacketArray.length, 1);
}


MCProtocol.prototype.prepareReadPacket = function() {
	var self = this;
	var itemList = self.polledReadBlockList;				// The items are the actual items requested by the user
	var requestList = [];						// The request list consists of the block list, split into chunks readable by PDU.  	
	var startOfSlice, endOfSlice, oldEndCoil, demandEndCoil;
	
	// Validity check.  
	for (i=itemList.length-1;i>=0;i--) {
		if (itemList[i] === undefined) {
			itemList.splice(i,1);
			outputLog("Dropping an undefined request item.",0,self.connectionID);
		}
	}
	
	// Sort the items using the sort function, by type and offset.  
	itemList.sort(itemListSorter);
	
	// Just exit if there are no items.  
	if (itemList.length == 0) {
		return undefined;
	}
	
	self.globalReadBlockList = [];
	
	// ...because you have to start your optimization somewhere.  
	self.globalReadBlockList[0] = itemList[0];
	self.globalReadBlockList[0].itemReference = [];
	self.globalReadBlockList[0].itemReference.push(itemList[0]);
	
	var maxByteRequest, thisBlock = 0;
	itemList[0].block = thisBlock;
// variable for MC		var maxByteRequest = 128; 
	
	// Optimize the items into blocks
	for (i=1;i<itemList.length;i++) {
		// Skip T, C, P types 
		maxByteRequest = itemList[i].maxWordLength(true)*2; // Will be 10*2 = 20 for bit native.  (160 point max)

		if ((itemList[i].areaMCCode !== self.globalReadBlockList[thisBlock].areaMCCode) ||   	// Can't optimize between areas
				(!self.isOptimizableArea(itemList[i].areaMCCode)) || 					// May as well try to optimize everything.  
				((itemList[i].offset - self.globalReadBlockList[thisBlock].offset + itemList[i].byteLength) > maxByteRequest) ||      	// If this request puts us over our max byte length, create a new block for consistency reasons.
				((itemList[i].offset - (self.globalReadBlockList[thisBlock].offset + self.globalReadBlockList[thisBlock].byteLength) > self.maxGap) && !itemList[i].bitNative) ||
				((itemList[i].offset - (self.globalReadBlockList[thisBlock].offset + self.globalReadBlockList[thisBlock].byteLength) > self.maxGap*8) && itemList[i].bitNative)) {		// If our gap is large, create a new block.
			// At this point we give up and create a new block.  
			thisBlock = thisBlock + 1;
			self.globalReadBlockList[thisBlock] = itemList[i]; // By reference.  
//				itemList[i].block = thisBlock; // Don't need to do this.  
			self.globalReadBlockList[thisBlock].isOptimized = false;
			self.globalReadBlockList[thisBlock].itemReference = [];
			self.globalReadBlockList[thisBlock].itemReference.push(itemList[i]);
//			outputLog("Not optimizing.");
		} else {
			outputLog("Performing optimization of item " + itemList[i].addr + " with " + self.globalReadBlockList[thisBlock].addr,1);
			// This next line checks the maximum.  
			// Think of this situation - we have a large request of 40 bytes starting at byte 10.  
			//	Then someone else wants one byte starting at byte 12.  The block length doesn't change.
			//
			// But if we had 40 bytes starting at byte 10 (which gives us byte 10-49) and we want byte 50, our byte length is 50-10 + 1 = 41.  

			if (itemList[i].bitNative) { // Coils and inputs must be special-cased 
				self.globalReadBlockList[thisBlock].byteLength = 
					Math.max(
						self.globalReadBlockList[thisBlock].byteLength, 
						(Math.floor((itemList[i].requestOffset - self.globalReadBlockList[thisBlock].requestOffset)/8) + itemList[i].byteLength)
					);
				if (self.globalReadBlockList[thisBlock].byteLength % 2) {  // shouldn't be necessary
					self.globalReadBlockList[thisBlock].byteLength += 1; 
				}
			} else {
				self.globalReadBlockList[thisBlock].byteLength = 
					Math.max(
					self.globalReadBlockList[thisBlock].byteLength, 
					((itemList[i].offset - self.globalReadBlockList[thisBlock].offset)*2 + Math.ceil(itemList[i].byteLength/itemList[i].multidtypelen))*itemList[i].multidtypelen
				);
			}
			outputLog("Optimized byte length is now " + self.globalReadBlockList[thisBlock].byteLength,1);
						
			// Point the buffers (byte and quality) to a sliced version of the optimized block.  This is by reference (same area of memory)
		if (itemList[i].bitNative) {  // Again a special case.  
				startOfSlice = (itemList[i].requestOffset - self.globalReadBlockList[thisBlock].requestOffset)/8; // NO, NO, NO - not the dtype length - start of slice varies with register width.  itemList[i].multidtypelen;
		} else { 
				startOfSlice = (itemList[i].requestOffset - self.globalReadBlockList[thisBlock].requestOffset)*2; // NO, NO, NO - not the dtype length - start of slice varies with register width.  itemList[i].multidtypelen;
			}

			endOfSlice = startOfSlice + itemList[i].byteLength;
			itemList[i].byteBuffer = self.globalReadBlockList[thisBlock].byteBuffer.slice(startOfSlice, endOfSlice);
			itemList[i].qualityBuffer = self.globalReadBlockList[thisBlock].qualityBuffer.slice(startOfSlice, endOfSlice);
				
			// For now, change the request type here, and fill in some other things.  

			// I am not sure we want to do these next two steps.
			// It seems like things get screwed up when we do this.
			// Since globalReadBlockList[thisBlock] exists already at this point, and our buffer is already set, let's not do this now.   
			// globalReadBlockList[thisBlock].datatype = 'BYTE';
			// globalReadBlockList[thisBlock].dtypelen = 1;
			self.globalReadBlockList[thisBlock].isOptimized = true;
			self.globalReadBlockList[thisBlock].itemReference.push(itemList[i]);
		}
	}
		
	var thisRequest = 0;
	
	// Split the blocks into requests, if they're too large.  
	for (i=0;i<self.globalReadBlockList.length;i++) {
		// Always create a request for a globalReadBlockList. 
		requestList[thisRequest] = self.globalReadBlockList[i].clone();
		
		// How many parts?
		maxByteRequest = self.globalReadBlockList[i].maxWordLength(true)*2; // Will be 10*2 = 20 for bit native.  (160 point max)
		self.globalReadBlockList[i].parts = Math.ceil(self.globalReadBlockList[i].byteLength/maxByteRequest);
		var startElement = self.globalReadBlockList[i].requestOffset; // try to ignore the offset
		var remainingLength = self.globalReadBlockList[i].byteLength;
		var remainingTotalArrayLength = self.globalReadBlockList[i].totalArrayLength;

		self.globalReadBlockList[i].requestReference = [];
		
		// If we need to spread the sending/receiving over multiple packets... 
		for (j=0;j<self.globalReadBlockList[i].parts;j++) {
			requestList[thisRequest] = self.globalReadBlockList[i].clone();
			self.globalReadBlockList[i].requestReference.push(requestList[thisRequest]);
			requestList[thisRequest].requestOffset = startElement;
			requestList[thisRequest].byteLength = Math.min(maxByteRequest,remainingLength);
			if (requestList[thisRequest].bitNative) {
				requestList[thisRequest].totalArrayLength = Math.min(maxByteRequest*8,remainingLength*8,self.globalReadBlockList[i].totalArrayLength); 			
			} else {
				requestList[thisRequest].totalArrayLength = Math.min(maxByteRequest/self.globalReadBlockList[i].dtypelen,remainingLength/self.globalReadBlockList[i].dtypelen,self.globalReadBlockList[i].totalArrayLength);
			}
			requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].byteLength;
			if (requestList[thisRequest].byteLengthWithFill % 2) { requestList[thisRequest].byteLengthWithFill += 1; };
			// Just for now...  I am not sure if we really want to do this in this case.  
			if (self.globalReadBlockList[i].parts > 1) {
				requestList[thisRequest].datatype = 'BYTE';
				requestList[thisRequest].dtypelen = 1;
				if (requestList[thisRequest].bitNative) {
					requestList[thisRequest].arrayLength = requestList[thisRequest].totalArrayLength;//globalReadBlockList[thisBlock].byteLength;		
				} else {
					requestList[thisRequest].arrayLength = requestList[thisRequest].byteLength/2;//globalReadBlockList[thisBlock].byteLength;		
				}
			}
			remainingLength -= maxByteRequest;
			if (self.globalReadBlockList[i].bitNative) {
//				startElement += maxByteRequest/requestList[thisRequest].multidtypelen;  
				startElement += maxByteRequest*8;
			} else {
				startElement += maxByteRequest/2; 
			}
			thisRequest++;
		}		
	}
	
	// The packetizer...
	var requestNumber = 0;
	var itemsThisPacket;
	
	self.clearReadPacketTimeouts();
	self.readPacketArray = [];

	while (requestNumber < requestList.length) {
		// Set up the read packet
		self.masterSequenceNumber += 1;
		if (self.masterSequenceNumber > 32767) {
			self.masterSequenceNumber = 1;
		}
		
		var numItems = 0;

		self.readPacketArray.push(new PLCPacket());
		var thisPacketNumber = self.readPacketArray.length - 1;
		self.readPacketArray[thisPacketNumber].seqNum = self.masterSequenceNumber;
	
		self.readPacketArray[thisPacketNumber].itemList = [];  // Initialize as array.  
	
		for (var i = requestNumber; i < requestList.length; i++) {
			if (numItems >= 1) {
				break;  // We can't fit this packet in here.  For now, this is always the case as we only have one item in MC protocol.
			}
			requestNumber++;
			numItems++;
			self.readPacketArray[thisPacketNumber].itemList.push(requestList[i]);
		}
	}
	self.readPacketValid = true;
}

MCProtocol.prototype.sendReadPacket = function() {
	var self = this;
	var i, j, curLength, returnedBfr, routerLength;
	var flagReconnect = false;
	
	outputLog("SendReadPacket called",1,self.connectionID);
	
	for (i = 0;i < self.readPacketArray.length; i++) {
		if (self.readPacketArray[i].sent) { continue; }
		if (self.parallelJobsNow >= self.maxParallel) { continue; }
		// From here down is SENDING the packet
		self.readPacketArray[i].reqTime = process.hrtime();	

		curLength = 0;
		routerLength = 0;
		
		// We always need an MC subheader BUT we are now going to do this in 
		//self.readWordHeader.copy(self.readReq, curLength);
		//curLength = self.readWordHeader.length;

		// The FOR loop is left in here for now, but really we are only doing one request per packet for now.  
		for (j = 0; j < self.readPacketArray[i].itemList.length; j++) {
			returnedBfr = MCAddrToBuffer(self.readPacketArray[i].itemList[j],false /* not writing */,self.isAscii);

			outputLog('The Returned MC Buffer is:',2);
			outputLog(returnedBfr, 2);
			outputLog("The returned buffer length is " + returnedBfr.length, 2);
			
			returnedBfr.copy(self.readReq, curLength);
			curLength += returnedBfr.length;
		}

		outputLog("The final send buffer is:", 2);
		if (self.isAscii) {
			outputLog(asciize(self.readReq.slice(0,curLength)), 2);
			outputLog(binarize(asciize(self.readReq.slice(0,curLength))),2);
		} else {
			outputLog(self.readReq.slice(0,curLength), 2);
		}
		
		if (self.isoConnectionState == 4) {
			self.readPacketArray[i].timeout = setTimeout(function(){
				self.packetTimeout.apply(self,arguments);
			}, self.globalTimeout, "read", self.readPacketArray[i].seqNum); 
			if (self.isAscii) {
				self.isoclient.write(asciize(self.readReq.slice(0,curLength)));  			
			} else {
				self.isoclient.write(self.readReq.slice(0,curLength));  // was 31
			}
			self.readPacketArray[i].sent = true;
			self.readPacketArray[i].rcvd = false;
			self.readPacketArray[i].timeoutError = false;
			self.parallelJobsNow += 1;
			outputLog('Sending Read Packet SEQ ' + self.readPacketArray[i].seqNum,1);	
		} else {
//			outputLog('Somehow got into read block without proper isoConnectionState of 4.  Disconnect.');
//			connectionReset();
//			setTimeout(connectNow, 2000, connectionParams);
// Note we aren't incrementing maxParallel so we are actually going to time out on all our packets all at once.    
			self.readPacketArray[i].sent = true;
			self.readPacketArray[i].rcvd = false;
			self.readPacketArray[i].timeoutError = true;	
			if (!flagReconnect) {
				// Prevent duplicates
				outputLog('Not Sending Read Packet because we are not connected - ISO CS is ' + self.isoConnectionState,0,self.connectionID);	
			}
			// This is essentially an instantTimeout.  
			if (self.isoConnectionState == 0) {
				flagReconnect = true;
			}
			outputLog('Requesting PacketTimeout Due to ISO CS NOT 4 - READ SN ' + self.readPacketArray[i].seqNum,1,self.connectionID);
			self.readPacketArray[i].timeout = setTimeout(function() {
				self.packetTimeout.apply(self, arguments);
			}, 0, "read", self.readPacketArray[i].seqNum); 
		}
	}

	if (flagReconnect) {
		setTimeout(function() {
			outputLog("The scheduled reconnect from sendReadPacket is happening now",1,self.connectionID);	
			self.connectNow(self.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark isoConnectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
}

MCProtocol.prototype.sendWritePacket = function() {
	var self = this;
	var dataBuffer, itemDataBuffer, dataBufferPointer, curLength, returnedBfr, flagReconnect = false;
	dataBuffer = new Buffer(8192);

	self.writeInQueue = false;
	
	for (i=0;i<self.writePacketArray.length;i++) {
		if (self.writePacketArray[i].sent) { continue; }
		if (self.parallelJobsNow >= self.maxParallel) { continue; }
		// From here down is SENDING the packet
		self.writePacketArray[i].reqTime = process.hrtime();	
		
		curLength = 0;
 
		// With MC we generate the simple header inside the packet generator as well
		dataBufferPointer = 0;
		for (var j = 0; j < self.writePacketArray[i].itemList.length; j++) {
			returnedBfr = MCAddrToBuffer(self.writePacketArray[i].itemList[j], true /* writing */,self.isAscii);
			returnedBfr.copy(self.writeReq, curLength);
			curLength += returnedBfr.length;
		}
	
		outputLog("The returned buffer length is " + returnedBfr.length,1);
		
		if (self.isoConnectionState === 4) {
			self.writePacketArray[i].timeout = setTimeout(function() {
				self.packetTimeout.apply(self, arguments);
			}, self.globalTimeout, "write", self.writePacketArray[i].seqNum); 
			outputLog("Actual Send Packet:",2);
			outputLog(self.writeReq.slice(0,curLength),2);
			if (self.isAscii) {
				self.isoclient.write(asciize(self.writeReq.slice(0,curLength)));  // was 31
			} else {
				self.isoclient.write(self.writeReq.slice(0,curLength));  // was 31
			}
			self.writePacketArray[i].sent = true;
			self.writePacketArray[i].rcvd = false;
			self.writePacketArray[i].timeoutError = false;
			self.parallelJobsNow += 1;
			outputLog('Sending Write Packet With Sequence Number ' + self.writePacketArray[i].seqNum,1,self.connectionID);
		} else {
			// This is essentially an instantTimeout.  
			self.writePacketArray[i].sent = true;
			self.writePacketArray[i].rcvd = false;
			self.writePacketArray[i].timeoutError = true;

			// Without the scopePlaceholder, this doesn't work.   writePacketArray[i] becomes undefined.
			// The reason is that the value i is part of a closure and when seen "nextTick" has the same value 
			// it would have just after the FOR loop is done.  
			// (The FOR statement will increment it to beyond the array, then exit after the condition fails)
			// scopePlaceholder works as the array is de-referenced NOW, not "nextTick".  
			var scopePlaceholder = self.writePacketArray[i].seqNum;
			process.nextTick(function() {
				self.packetTimeout("write", scopePlaceholder);
			});
			if (self.isoConnectionState == 0) {
				flagReconnect = true;
			}
		}
	}
	if (flagReconnect) {
		setTimeout(function() {
			outputLog("The scheduled reconnect from sendWritePacket is happening now",1,self.connectionID);	
			self.connectNow(self.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark isoConnectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
}

MCProtocol.prototype.isOptimizableArea = function(area) {
	var self = this;
	// For MC protocol always say yes.  
	if (self.doNotOptimize) { return false; } // Are we skipping all optimization due to user request?
	
	return true;
}

MCProtocol.prototype.onResponse = function(rawdata) {
	var self = this;
	var isReadResponse, isWriteResponse,data;	
	// Packet Validity Check.  
	
	if (!self.isAscii) {
		data = rawdata;
	} else {
		data = binarize(rawdata);
		if (typeof(data) === 'undefined') {
			outputLog('Failed ASCII conversion to binary on reply. Ignoring packet.');
			outputLog(data,0);
			return null;
		}
	}
	
	// Decrement our parallel jobs now

	// NOT SO FAST - can't do this here.  If we time out, then later get the reply, we can't decrement this twice.  Or the CPU will not like us.  Do it if not rcvd.  parallelJobsNow--;

	outputLog("onResponse called with length " + data.length,1);
	
	if (data.length < 2) { 
		outputLog('DATA LESS THAN 2 BYTES RECEIVED.  NO PROCESSING WILL OCCUR - CONNECTION RESET.');
		outputLog(data,0);
		self.connectionReset();
		return null;
	}
	
	outputLog('Valid MC Response Received (not yet checked for error)', 1);
	
	// Log the receive
	outputLog('Received ' + data.length + ' bytes of data from PLC.', 1); 
	outputLog(data, 2);
	
	// Check the sequence number	


	// On a lot of other industrial protocols the sequence number is coded as part of the 
	// packet and read in the response which is used as a check.
	
	// On the MC protocol, we can't do that - so we need to either give up on tracking sequence
	// numbers (this is what we've done) or fake sequence numbers (adds code complexity for no perceived benefit)

	if (self.isReading()) {
		isReadResponse = true;
		outputLog("Received Read Response",1);		
		self.readResponse(data);
	}
	
	if (self.isWriting()) {
		isWriteResponse = true;
		outputLog("Received Write Response",1);
		self.writeResponse(data);
	}
		
	if ((!isReadResponse) && (!isWriteResponse)) {
		outputLog("Sequence number that arrived wasn't a write or read reply - dropping");
		outputLog(data,0);
		// 	I guess this isn't a showstopper, just ignore it.  In situations like this we used to reset.
		return null;
	}
}

MCProtocol.prototype.writeResponse = function(data) {
	var self = this;
	var dataPointer = 2,i,anyBadQualities,sentPacketNum;

	for (packetCounter = 0; packetCounter < self.writePacketArray.length; packetCounter++) {
		if (self.writePacketArray[packetCounter].sent && !(self.writePacketArray[packetCounter].rcvd)) {
			sentPacketNum = packetCounter; 
			break; // Done with the FOR loop
		}
	}
	
	if (typeof(sentPacketNum) === 'undefined') {
		outputLog('WARNING: Received a write packet when none marked as sent',0,self.connectionID);
		return null;
	}
	
	if (self.writePacketArray[sentPacketNum].rcvd) {
		outputLog('WARNING: Received a write packet that was already marked as received',0,self.connectionID);
		return null;
	}
	
	for (itemCount = 0; itemCount < self.writePacketArray[sentPacketNum].itemList.length; itemCount++) {
		dataPointer = processMBWriteItem(data, self.writePacketArray[sentPacketNum].itemList[itemCount], dataPointer);
		if (!dataPointer) {
			outputLog('Stopping Processing Write Response Packet due to unrecoverable packet error');
			break;
		}
	}

	// Make a note of the time it took the PLC to process the request.  
	self.writePacketArray[sentPacketNum].reqTime = process.hrtime(self.writePacketArray[sentPacketNum].reqTime);
	outputLog('Time is ' + self.writePacketArray[sentPacketNum].reqTime[0] + ' seconds and ' + Math.round(self.writePacketArray[sentPacketNum].reqTime[1]*10/1e6)/10 + ' ms.',1);

//	writePacketArray.splice(sentPacketNum, 1);
	if (!self.writePacketArray[sentPacketNum].rcvd) {
		self.writePacketArray[sentPacketNum].rcvd = true;
		self.parallelJobsNow--;
	}
	clearTimeout(self.writePacketArray[sentPacketNum].timeout);	
	
	if (!self.writePacketArray.every(doneSending)) {
//			readPacketInterval = setTimeout(prepareReadPacket, 3000);
		self.sendWritePacket();
		outputLog("Sending again",1);
	} else {
		for (i=0;i<self.writePacketArray.length;i++) {
			self.writePacketArray[i].sent = false;
			self.writePacketArray[i].rcvd = false;				
		}
		
		anyBadQualities = false;
		
		for (i=0;i<self.globalWriteBlockList.length;i++) {
			// Post-process the write code and apply the quality.  
			// Loop through the global block list...
			writePostProcess(self.globalWriteBlockList[i]);
			outputLog(self.globalWriteBlockList[i].addr + ' write completed with quality ' + self.globalWriteBlockList[i].writeQuality,0);
			if (!isQualityOK(self.globalWriteBlockList[i].writeQuality)) { anyBadQualities = true; }
		}
		if (typeof(self.writeDoneCallback === 'function')) {
			self.writeDoneCallback(anyBadQualities);
		}
	}
}

MCProtocol.prototype.readResponse = function(data) {
	var self = this;
	var anyBadQualities,dataPointer = 21,rcvdPacketNum;  // For non-routed packets we start at byte 21 of the packet.  If we do routing it will be more than this.  
	var dataObject = {};
	
	outputLog("ReadResponse called",1,self.connectionID);

	for (packetCounter = 0; packetCounter < self.readPacketArray.length; packetCounter++) {
		if (self.readPacketArray[packetCounter].sent && !(self.readPacketArray[packetCounter].rcvd)) {
			rcvdPacketNum = packetCounter; 
			break; // Done with the FOR loop
		}
	}
	
	if (typeof(rcvdPacketNum) === 'undefined') {
		outputLog('WARNING: Received a read response packet that was not marked as sent',0,self.connectionID);
		//TODO - fix the network unreachable error that made us do this		
		return null;
	}
	
	if (self.readPacketArray[rcvdPacketNum].rcvd) {
		outputLog('WARNING: Received a read response packet that was already marked as received',0,self.connectionID);
		return null;
	}
	
	for (itemCount = 0; itemCount < self.readPacketArray[rcvdPacketNum].itemList.length; itemCount++) {
		dataPointer = processMBPacket(data, self.readPacketArray[rcvdPacketNum].itemList[itemCount], dataPointer);
		if (!dataPointer && typeof(data) !== "undefined") {
			// Don't bother showing this message on timeout.
			outputLog('Received a ZERO RESPONSE Processing Read Packet due to unrecoverable packet error');
//			break;  // We rely on this for our timeout now.  
		}
	}
	
	// Make a note of the time it took the PLC to process the request.  
	self.readPacketArray[rcvdPacketNum].reqTime = process.hrtime(self.readPacketArray[rcvdPacketNum].reqTime);
	outputLog('Read Time is ' + self.readPacketArray[rcvdPacketNum].reqTime[0] + ' seconds and ' + Math.round(self.readPacketArray[rcvdPacketNum].reqTime[1]*10/1e6)/10 + ' ms.',1,self.connectionID);

	// Do the bookkeeping for packet and timeout.  
	if (!self.readPacketArray[rcvdPacketNum].rcvd) {
		self.readPacketArray[rcvdPacketNum].rcvd = true;
		self.parallelJobsNow--;
		if (self.parallelJobsNow < 0) { self.parallelJobsNow = 0; }
	}
	clearTimeout(self.readPacketArray[rcvdPacketNum].timeout);	
	
	if(self.readPacketArray.every(doneSending)) {  // if sendReadPacket returns true we're all done.  
		// Mark our packets unread for next time.  
		outputLog('Every packet done sending',1,self.connectionID);
		for (i=0;i<self.readPacketArray.length;i++) {
			self.readPacketArray[i].sent = false;
			self.readPacketArray[i].rcvd = false;
		}
	
		anyBadQualities = false;
		
		// Loop through the global block list...
		for (var i=0;i<self.globalReadBlockList.length;i++) {
			var lengthOffset = 0;
			// For each block, we loop through all the requests.  Remember, for all but large arrays, there will only be one.  
			for (var j=0;j<self.globalReadBlockList[i].requestReference.length;j++) {
				// Now that our request is complete, we reassemble the BLOCK byte buffer as a copy of each and every request byte buffer.
				self.globalReadBlockList[i].requestReference[j].byteBuffer.copy(self.globalReadBlockList[i].byteBuffer,lengthOffset,0,self.globalReadBlockList[i].requestReference[j].byteLength);
				self.globalReadBlockList[i].requestReference[j].qualityBuffer.copy(self.globalReadBlockList[i].qualityBuffer,lengthOffset,0,self.globalReadBlockList[i].requestReference[j].byteLength);
				lengthOffset += self.globalReadBlockList[i].requestReference[j].byteLength;				
			}
			// For each ITEM reference pointed to by the block, we process the item. 
			for (var k=0;k<self.globalReadBlockList[i].itemReference.length;k++) {
//				outputLog(self.globalReadBlockList[i].itemReference[k].byteBuffer);
				processMCReadItem(self.globalReadBlockList[i].itemReference[k],self.isAscii);
				outputLog('Address ' + self.globalReadBlockList[i].itemReference[k].addr + ' has value ' + self.globalReadBlockList[i].itemReference[k].value + ' and quality ' + self.globalReadBlockList[i].itemReference[k].quality,1,self.connectionID);
				if (!isQualityOK(self.globalReadBlockList[i].itemReference[k].quality)) { 
					anyBadQualities = true; 
					dataObject[self.globalReadBlockList[i].itemReference[k].useraddr] = self.globalReadBlockList[i].itemReference[k].quality;
				} else {
					dataObject[self.globalReadBlockList[i].itemReference[k].useraddr] = self.globalReadBlockList[i].itemReference[k].value;				
				}
			}
		}
		
		// Inform our user that we are done and that the values are ready for pickup.

		outputLog("We are calling back our readDoneCallback.",1,self.connectionID);
		if (typeof(self.readDoneCallback === 'function')) {
			self.readDoneCallback(anyBadQualities, dataObject);
		}
		if (self.resetPending) {
			self.resetNow();
		}
		if (!self.isReading() && self.writeInQueue) { self.sendWritePacket(); }
	} else {
		outputLog("Calling SRP from RR",1,self.connectionID);
		self.sendReadPacket();
	}
}

MCProtocol.prototype.onClientDisconnect = function() {
	var self = this;
	outputLog('EIP/TCP DISCONNECTED.');
	self.connectionCleanup();
	self.tryingToConnectNow = false;
}

MCProtocol.prototype.connectionReset = function() {
	var self = this;
	self.isoConnectionState = 0;
	self.resetPending = true;
	outputLog('ConnectionReset is happening');
	// The problem is that if we are interrupted before a read can be completed, say we get a bogus packet - we'll never recover.
	// We 
	if (!self.isReading() && typeof(self.resetTimeout) === 'undefined') { // For now - ignore writes.  && !isWriting()) {	
		self.resetTimeout = setTimeout(function() {
			self.resetNow.apply(self, arguments);
		} ,1500);
	} 
	// For now we wait until read() is called again to re-connect.  
}

MCProtocol.prototype.resetNow = function() {
	var self = this;
	self.isoConnectionState = 0;
	self.isoclient.end();
	outputLog('ResetNOW is happening');
	self.resetPending = false;
	// In some cases, we can have a timeout scheduled for a reset, but we don't want to call it again in that case.
	// We only want to call a reset just as we are returning values.  Otherwise, we will get asked to read // more values and we will "break our promise" to always return something when asked. 
	if (typeof(self.resetTimeout) !== 'undefined') {
		clearTimeout(self.resetTimeout);
		self.resetTimeout = undefined;
		outputLog('Clearing an earlier scheduled reset');
	}
}

MCProtocol.prototype.connectionCleanup = function() {
	var self = this;
	self.isoConnectionState = 0;
	outputLog('Connection cleanup is happening');	
	if (typeof(self.isoclient) !== "undefined") {
		self.isoclient.removeAllListeners('data');
		self.isoclient.removeAllListeners('error');
		self.isoclient.removeAllListeners('connect');
		self.isoclient.removeAllListeners('end');
	}
	clearTimeout(self.connectTimeout);
	clearTimeout(self.PDUTimeout);
	self.clearReadPacketTimeouts();  // Note this clears timeouts.  
	self.clearWritePacketTimeouts();  // Note this clears timeouts.   
}

function outputLog(txt, debugLevel, id) {
	var idtext;
	if (typeof(id) === 'undefined') {
		idtext = '';
	} else {
		idtext = ' ' + id;
	}
	if (typeof(debugLevel) === 'undefined' || effectiveDebugLevel >= debugLevel) { console.log('[' + process.hrtime() + idtext + '] ' + util.format(txt)); }
}

function doneSending(element) {
	return ((element.sent && element.rcvd) ? true : false);
}

function processMBPacket(theData, theItem, thePointer) {
	var remainingLength;
	
	if (typeof(theData) === "undefined") {
		remainingLength = 0;
//		outputLog("Processing an undefined packet, likely due to timeout error");
	} else {
		remainingLength = theData.length;
	}
	
	var prePointer = thePointer;

	// Create a new buffer for the quality.  
	theItem.qualityBuffer = new Buffer(theItem.byteLength);
	theItem.qualityBuffer.fill(0xFF);  // Fill with 0xFF (255) which means NO QUALITY in the OPC world.  
	
	if (remainingLength < 2) {
		theItem.valid = false;
		if (typeof(theData) !== "undefined") {
			theItem.errCode = 'Malformed MC Packet - Less Than 2 Bytes.  TDL ' + theData.length + ' TP ' + thePointer + ' RL' + remainingLength;
			outputLog(theItem.errCode,0);  // Can't log more info here as we dont have "self" info
		} else {
			theItem.errCode = "Timeout error - zero length packet";
			outputLog(theItem.errCode,1);  // Can't log more info here as we dont have "self" info
		}
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.      
	}
	
	if (theData[0] !== 0x81) { // 0x80 = bit reply, 0x81 = word reply
		theItem.valid = false;
		theItem.errCode = 'Invalid MC - Expected first byte (binary) to be 0x81 (129) - got ' + decimalToHexString(theData[0]) + " (" + theData[0] + ")";
		outputLog(theItem.errCode);
		return 1; //thePointer + reportedDataLength + 4;
	}
	
	if (theData[1] !== 0x00) {
		theItem.valid = false;
		theItem.errCode = 'MC Error Response - Second Byte is ' + theData[1] + ' and error code is ' + theData[2];
		outputLog(theItem.errCode);
		return 1; //thePointer + reportedDataLength + 4;   			      
	}	

	// There is no reported data length to check here - 
	// reportedDataLength = theData[9];

	expectedLength = theItem.byteLength;
			
	if (theData.length - 2 !== expectedLength) {
		theItem.valid = false;
		theItem.errCode = 'Invalid Response Length - Expected ' + expectedLength + ' but got ' + (theData.length - 2) + ' bytes.';
		outputLog(theItem.errCode);
		return 1;  
	}	
	
	// Looks good so far.  
	// Increment our data pointer past the 2 byte subheader and complete code.
	thePointer += 2;
	
	var arrayIndex = 0;
	
	theItem.valid = true;
	theItem.byteBuffer = theData.slice(2); // This means take to end.
	
	outputLog('Byte Buffer is:',2);
	outputLog(theItem.byteBuffer,2);
	
	theItem.qualityBuffer.fill(0xC0);  // Fill with 0xC0 (192) which means GOOD QUALITY in the OPC world.  
	outputLog('Marking quality as good L' + theItem.qualityBuffer.length,2);
		
	return -1; //thePointer;
}

function processMBWriteItem(theData, theItem, thePointer) {
	
//	var remainingLength = theData.length - thePointer;  // Say if length is 39 and pointer is 35 we can access 35,36,37,38 = 4 bytes.  
//	var prePointer = thePointer;
	
	if (typeof(theData) === 'undefined' || theData.length < 2) {  // Should be at least 11 bytes with 7 byte header
		theItem.valid = false;
		theItem.errCode = 'Malformed Reply MC Packet - Less Than 2 Bytes' + theData;
		outputLog(theItem.errCode);
		theItem.writeQualityBuffer.fill(0xFF);  // Note that ff is BAD in our fill here. 		
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.      
	}
	
	var writeResponse = theData.readUInt8(1);
	
	if (writeResponse !== 0x00 || (theData[0] !== 0x82) && (theData[0] !== 0x83)) {
		if (theData.length > 2) {
			outputLog ('Received response ' + theData[0] + ' ' + theData[1] + ' ' + theData[2] + ') indicating write error on ' + theItem.addr);
		} else {
			outputLog ('Received response ' + theData[0] + ' ' + theData[1] + ') indicating write error on ' + theItem.addr);
		}
		theItem.writeQualityBuffer.fill(0xFF);  // Note that ff is BAD in our fill here.  
	} else {
		theItem.writeQualityBuffer.fill(0xC0);
	}	
	
	return -1;
}

function writePostProcess(theItem) {
	var thePointer = 0;
	if (theItem.arrayLength === 1) {
		if (theItem.writeQualityBuffer[0] === 0xFF) { 
			theItem.writeQuality = 'BAD';
		} else { 
			theItem.writeQuality = 'OK';
		}
	} else {
		// Array value.
		theItem.writeQuality = [];
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			if (theItem.writeQualityBuffer[thePointer] === 0xFF) { 
				theItem.writeQuality[arrayIndex] = 'BAD';
			} else { 
				theItem.writeQuality[arrayIndex] = 'OK';
			}
			if (theItem.datatype == 'X' ) {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  
				if ((((arrayIndex + theItem.bitOffset + 1) % 8) == 0) || (arrayIndex == theItem.arrayLength - 1)){
					thePointer += theItem.dtypelen;
				}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen;
			}
		}
	} 
}


function processMCReadItem(theItem, isAscii) {
	
	var thePointer = 0,tempBuffer = new Buffer(4);
	
	if (theItem.arrayLength > 1) {
		// Array value.  
		if (theItem.datatype != 'C' && theItem.datatype != 'CHAR') {
			theItem.value = [];
			theItem.quality = [];
		} else {
			theItem.value = '';
			theItem.quality = '';
		}
		var bitShiftAmount = theItem.bitOffset;
		if (theItem.bitNative) {
			bitShiftAmount = theItem.remainder;
		}

		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			if (theItem.qualityBuffer[thePointer] !== 0xC0) {
				theItem.value.push(theItem.badValue());
				theItem.quality.push('BAD ' + theItem.qualityBuffer[thePointer]);
				outputLog("Logging a Bad Quality thePointer " + thePointer,2);
			} else {
				// If we're a string, quality is not an array.
				if (theItem.quality instanceof Array) {
					theItem.quality.push('OK');
				} else {
					theItem.quality = 'OK';
				}
				switch(theItem.datatype) {

				case "REAL":
					if (isAscii) {
						theItem.value.push(getFloatBESwap(theItem.byteBuffer, thePointer));					
					} else {
						theItem.value.push(theItem.byteBuffer.readFloatLE(thePointer));						
					}
					break;
				case "DWORD":
					if (isAscii) {
						theItem.value.push(getUInt32BESwap(theItem.byteBuffer, thePointer));					
					} else {
						theItem.value.push(theItem.byteBuffer.readUInt32LE(thePointer));
					}
					break;
				case "DINT":
					if (isAscii) {
						theItem.value.push(getInt32BESwap(theItem.byteBuffer, thePointer));					
					} else {
						theItem.value.push(theItem.byteBuffer.readInt32LE(thePointer));
					}
					break;
				case "INT":
					if (isAscii) {
						theItem.value.push(theItem.byteBuffer.readInt16BE(thePointer));
					} else {
						theItem.value.push(theItem.byteBuffer.readInt16LE(thePointer));
					}
					break;
				case "WORD":
					if (isAscii) {
						theItem.value.push(theItem.byteBuffer.readUInt16BE(thePointer));
					} else {
						theItem.value.push(theItem.byteBuffer.readUInt16LE(thePointer));
					}
					break;
				case "X":
					if (theItem.bitNative) {
						if (isAscii) {
							theItem.value.push(((theItem.byteBuffer.readUInt16BE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
						} else {
							theItem.value.push(((theItem.byteBuffer.readUInt16LE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
						}
					} else {
						if (isAscii) {
							theItem.value.push(((theItem.byteBuffer.readUInt16BE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
						} else {
							theItem.value.push(((theItem.byteBuffer.readUInt16LE(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
						}
					}
					break;
				case "B":
				case "BYTE":
					if (isAscii) {
						if (arrayIndex % 2) {
							theItem.value.push(theItem.byteBuffer.readUInt8(thePointer - 1));
						} else {
							theItem.value.push(theItem.byteBuffer.readUInt8(thePointer + 1));
						}
					} else {
						theItem.value.push(theItem.byteBuffer.readUInt8(thePointer));
					}
					break;

				case "C":
				case "CHAR":
					// Convert to string.  
					if (isAscii) {
						if (arrayIndex % 2) {
							theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer - 1));
						} else {
							theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer + 1));
						}
					} else {
						theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
					}
					break;
			
				default:
					outputLog("Unknown data type in response - should never happen.  Should have been caught earlier.  " + theItem.datatype);
					return 0;		
				}
			}
			if (theItem.datatype == 'X' ) {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset. 
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to 
				// drop support for this at the request level or support it here.  
				bitShiftAmount++;
				if (theItem.bitNative) {
					if ((((arrayIndex + theItem.remainder + 1) % 16) == 0) || (arrayIndex == theItem.arrayLength - 1)){ // NOTE: The second or case is for the case of the end of an array where we increment for next read - not important for MC protocol
						thePointer += theItem.dtypelen;  
						bitShiftAmount = 0;
					}
				} else {
					// Never tested
					if ((((arrayIndex + theItem.bitOffset + 1) % 16) == 0) || (arrayIndex == theItem.arrayLength - 1)){
						thePointer += theItem.dtypelen; // I guess this is 1 for bits.  
						bitShiftAmount = 0;
					}
				}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen; 	
			}
		}
	} else {		
		// Single value.  	
		if (theItem.qualityBuffer[thePointer] !== 0xC0) {
			theItem.value = theItem.badValue();
			theItem.quality = ('BAD ' + theItem.qualityBuffer[thePointer]);
			outputLog("Item Quality is Bad", 1);			
		} else {
			theItem.quality = ('OK');
			outputLog("Item Datatype (single value) is " + theItem.datatype, 1);			
			switch(theItem.datatype) {

			case "REAL":
				if (isAscii) {
					theItem.value = getFloatBESwap(theItem.byteBuffer, thePointer);					
				} else {
					theItem.value = theItem.byteBuffer.readFloatLE(thePointer);
				}
				break;
			case "DWORD":
				if (isAscii) {
					theItem.value = getUInt32BESwap(theItem.byteBuffer, thePointer);					
				} else {
					theItem.value = theItem.byteBuffer.readUInt32LE(thePointer);					
				}
				break;
			case "DINT":
				if (isAscii) {
					theItem.value = getInt32BESwap(theItem.byteBuffer, thePointer);					
				} else {
					theItem.value = theItem.byteBuffer.readInt32LE(thePointer);					
				}
				break;
			case "INT":
				if (isAscii) {
					theItem.value = theItem.byteBuffer.readInt16BE(thePointer);					
				} else {
					theItem.value = theItem.byteBuffer.readInt16LE(thePointer);					
				}
				break;
			case "WORD":
				if (isAscii) {
					theItem.value = theItem.byteBuffer.readUInt16BE(thePointer);					
				} else {
					theItem.value = theItem.byteBuffer.readUInt16LE(thePointer);					
				}
				break;
			case "X":
//			outputLog("Reading single Value ByteBufferLength is " + theItem.byteBuffer.length, 1);
				if (theItem.bitNative) {
					if (isAscii) {
						theItem.value = (((theItem.byteBuffer.readUInt16BE(thePointer) >> (theItem.remainder)) & 1) ? true : false);
					} else {
						theItem.value = (((theItem.byteBuffer.readUInt16LE(thePointer) >> (theItem.remainder)) & 1) ? true : false);
					}
				} else {
					if (isAscii) {
						theItem.value = (((theItem.byteBuffer.readUInt16BE(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
					} else {
						theItem.value = (((theItem.byteBuffer.readUInt16LE(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
					}
				}
				break;
			case "B":
			case "BYTE":
				// No support as of yet for signed 8 bit.  This isn't that common.  
				if (isAscii) {
					theItem.value = theItem.byteBuffer.readUInt8(thePointer + 1);
				} else {
					theItem.value = theItem.byteBuffer.readUInt8(thePointer);
				}
				break;
			case "C":
			case "CHAR":
				// No support as of yet for signed 8 bit.  This isn't that common.  
				if (isAscii) {
					theItem.value = String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer + 1));
				} else {
					theItem.value = String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
				}
				break;
			default:
				outputLog("Unknown data type in response - should never happen.  Should have been caught earlier.  " + theItem.datatype);
				return 0;		
			}
		}
		thePointer += theItem.dtypelen; 	
	}	

	if (((thePointer) % 2)) { // Odd number.  
		thePointer += 1;
	}

	return thePointer; // Should maybe return a value now???
}

function bufferizeMCItem(theItem, isAscii) {	
	var thePointer, theByte;
	theByte = 0;
	thePointer = 0; // After length and header
	
	if (theItem.arrayLength > 1) {
		// Array value.  
		var bitShiftAmount = theItem.bitOffset;
		for (arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			switch(theItem.datatype) {
				case "REAL":
					if (isAscii) {
						setFloatBESwap(theItem.writeBuffer, thePointer, theItem.writeValue[arrayIndex]);			
					} else {
						theItem.writeBuffer.writeFloatLE(theItem.writeValue[arrayIndex], thePointer);					
					}
					break;
				case "DWORD":
					if (isAscii) {
						setUInt32BESwap(theItem.writeBuffer, thePointer, theItem.writeValue[arrayIndex]);					
					} else {
						theItem.writeBuffer.writeUInt32LE(theItem.writeValue[arrayIndex], thePointer);						
					}
					break;
				case "DINT":
					if (isAscii) {
						setInt32BESwap(theItem.writeBuffer, thePointer, theItem.writeValue[arrayIndex]);					
					} else {
						theItem.writeBuffer.writeInt32LE(theItem.writeValue[arrayIndex], thePointer);						
					}
					break;
				case "INT":
					if (isAscii) {
						theItem.writeBuffer.writeInt16BE(theItem.writeValue[arrayIndex], thePointer);					
					} else {
						theItem.writeBuffer.writeInt16LE(theItem.writeValue[arrayIndex], thePointer);						
					}
					break;
				case "WORD":
					if (isAscii) {
						theItem.writeBuffer.writeUInt16BE(theItem.writeValue[arrayIndex], thePointer);					
					} else {
						theItem.writeBuffer.writeUInt16LE(theItem.writeValue[arrayIndex], thePointer);						
					}
					break;
				case "X":
					if (arrayIndex % 2) {
						theByte = theByte | ((theItem.writeValue[arrayIndex] === true) ? 1 : 0);		
					} else {
						theByte = theByte | (((theItem.writeValue[arrayIndex] === true) ? 1 : 0) << 4);								
					}
					// Maybe not so efficient to do this every time when we only need to do it every 8.  Need to be careful with optimizations here for odd requests.  
					theItem.writeBuffer.writeUInt8(theByte, thePointer);
					theItem.writeBuffer.writeUInt8(0, thePointer+1);  // Zero out the pad byte
					//bitShiftAmount++;
					break;
				case "B":
				case "BYTE":
					if (isAscii) {
						if (arrayIndex % 2) {
							theItem.writeBuffer.writeUInt8(theItem.writeValue[arrayIndex], thePointer - 1);
						} else {
							theItem.writeBuffer.writeUInt8(theItem.writeValue[arrayIndex], thePointer + 1);
						}
					} else {
						theItem.writeBuffer.writeUInt8(Math.round(theItem.writeValue[arrayIndex]), thePointer);
					}
					break;
				case "C":
				case "CHAR":
					// Convert to string.  
					if (isAscii) {
						if (arrayIndex % 2) {
							theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer - 1);
						} else {
							theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer + 1);
						}
					} else {
						theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer);
					}
					break;
				default:
					outputLog("Unknown data type when preparing array write packet - should never happen.  Should have been caught earlier.  " + theItem.datatype);
					return 0;		
			}
			if (theItem.datatype == 'X' ) {
				// Increment the pointer "sometimes" - only when we cross byte boundaries, then set to zero as we "AND" things together to build the byte.
				if (arrayIndex % 2) {
					thePointer += 1;
					theByte = 0;
				}
			} else {
				// Add to the pointer every time.  
				thePointer += theItem.dtypelen;
			}
		}
	} else {
		// Single value. 
		switch(theItem.datatype) {

			case "REAL":
				if (isAscii) {
					setFloatBESwap(theItem.writeBuffer, thePointer, theItem.writeValue);
				} else {
					theItem.writeBuffer.writeFloatLE(theItem.writeValue, thePointer);					
				}
				break;
			case "DWORD":
				if (isAscii) {
					setUInt32BESwap(theItem.writeBuffer, thePointer, theItem.writeValue);
				} else {
					theItem.writeBuffer.writeUInt32LE(theItem.writeValue, thePointer);
				}
				break;
			case "DINT":
				if (isAscii) {
					setInt32BESwap(theItem.writeBuffer, thePointer, theItem.writeValue);
				} else {
					theItem.writeBuffer.writeInt32LE(theItem.writeValue, thePointer);
				}
				break;
			case "INT":
				if (isAscii) {
					theItem.writeBuffer.writeInt16BE(theItem.writeValue, thePointer);
				} else {
					theItem.writeBuffer.writeInt16LE(theItem.writeValue, thePointer);
				}
				break;
			case "WORD":
				if (isAscii) {
					theItem.writeBuffer.writeUInt16BE(theItem.writeValue, thePointer);
				} else {
					theItem.writeBuffer.writeUInt16LE(theItem.writeValue, thePointer);
				}
				break;
			case "X":
				if (theItem.bitNative) {
					theItem.writeBuffer.writeUInt8(((theItem.writeValue) ? 0x10 : 0x00), thePointer);  // checked ===true but this caused problems if you write 1
					theItem.writeBuffer.writeUInt8(0x00, thePointer+1);  
					outputLog("Datatype is X writing " + theItem.writeValue + " tpi " + theItem.writeBuffer[0],1);
				} else {
					outputLog("We don't support writing individual bits of non-native types - write the whole word externally please",0);
				}
// not here				theItem.writeBuffer[1] = 1; // Set transport code to "BIT" to write a single bit. 
// not here				theItem.writeBuffer.writeUInt16BE(1, 2); // Write only one bit.  				
				break;
			case "B":
			case "BYTE":
				// No support as of yet for signed 8 bit.  This isn't that common.  
				if (isAscii) {
					theItem.writeBuffer.writeUInt8(Math.round(theItem.writeValue), thePointer + 1);
					theItem.writeBuffer.writeUInt8(0, thePointer);
				} else {
					theItem.writeBuffer.writeUInt8(Math.round(theItem.writeValue), thePointer);
				}
				break;
			case "C":
			case "CHAR":
				// No support as of yet for signed 8 bit.  This isn't that common.  
				if (isAscii) {
					theItem.writeBuffer.writeUInt8(String.toCharCode(theItem.writeValue), thePointer + 1);
					theItem.writeBuffer.writeUInt8(0, thePointer);
				} else {
					theItem.writeBuffer.writeUInt8(String.toCharCode(theItem.writeValue), thePointer);
				}
				break;	
			default:
				outputLog("Unknown data type in write prepare - should never happen.  Should have been caught earlier.  " + theItem.datatype);
				return 0;		
		}
		thePointer += theItem.dtypelen; 	
	}	
	return undefined; 
}

function isQualityOK(obj) {
	if (typeof obj === "string") { 
		if (obj !== 'OK') { return false; } 
	} else if (_.isArray(obj)) {
		for (i = 0; i < obj.length; i++) {
			if (typeof obj[i] !== "string" || obj[i] !== 'OK') { return false; }
		}
	}
	return true;
}

function MCAddrToBuffer(addrinfo, isWriting, isAscii) { 
	var headerLength, writeLength, MCCommand = new Buffer(300);  // 12 is max length with all fields at max.  
	
	headerLength = 4;
	
	// Hard code the header.  Note that for bit devices, we use the less-efficient, but easier to program, bit device read.
	if (addrinfo.bitNative) {
		if (isWriting) {		
			MCCommand[0] = 0x02;
		} else {
			MCCommand[0] = 0x01; // For now we read words.
		}
	} else {
		if (isWriting) {		
			MCCommand[0] = 0x03;
		} else {
			MCCommand[0] = 0x01;
		}	
	}

	MCCommand[1] = 0xff;
	
	if (isAscii) {
		outputLog("We're Ascii",2);
		MCCommand.writeUInt16BE(monitoringTime, 2);
	} else {
		outputLog("We're Binary",2);
		MCCommand.writeUInt16LE(monitoringTime, 2);	
	}
	
	writeLength = isWriting ? (addrinfo.byteLengthWrite) : 0; // Shouldn't ever be zero
	
	// Write the data type code
	if (isAscii) {
		MCCommand.writeUInt16BE(addrinfo.areaMCCode, 4);
	} else {
		MCCommand.writeUInt16LE(addrinfo.areaMCCode, 8);	
	}

	// Write the data request offset
	if (isAscii) {
		if (isWriting) {
			MCCommand.writeUInt32BE(addrinfo.offset, 6);
		} else {
			MCCommand.writeUInt32BE(addrinfo.requestOffset, 6);
		}	
	} else {
		if (isWriting) {
			MCCommand.writeUInt32LE(addrinfo.offset, 4);
		} else {
			// RequestOffset ensures bit-native types are read as a word
			MCCommand.writeUInt32LE(addrinfo.requestOffset, 4);
		}	
	}
	
	// Number of elements in request - for single-bit, 16-bit, 32-bit, this is always the number of WORDS
	if (addrinfo.bitNative && isWriting) {
		// set to bit length
		MCCommand.writeUInt8(addrinfo.arrayLength, 10);
	} else if (addrinfo.bitNative && !isWriting) {
		MCCommand.writeUInt8(Math.ceil((addrinfo.arrayLength + addrinfo.remainder)/16), 10);
	} else {
// doesn't work with optimized blocks where array length isn't right		MCCommand.writeUInt8(addrinfo.arrayLength*addrinfo.dataTypeByteLength()/2, 10);
		if (isWriting) {
			MCCommand.writeUInt8(addrinfo.byteLengthWrite/2, 10);
		} else {
			MCCommand.writeUInt8(addrinfo.byteLength/2, 10);		
		}
	}
	
	// Spec says to write 0 here
	MCCommand.writeUInt8(0, 11);
	
	if (isWriting) {
		addrinfo.writeBuffer.copy(MCCommand,12,0,writeLength);
	}
	
	return MCCommand.slice(0,12+writeLength); // WriteLength is the length we write.  writeLength - 1 is the data length.  
}

function stringToMCAddr(addr, useraddr, octalInputOutput) {
	"use strict";
	var theItem, splitString, splitString2, prefix, postDotAlpha, postDotNumeric, forceBitDtype, preOctalOffset;
	theItem = new PLCItem();

	if (useraddr === '_COMMERR') { return undefined; } // Special-case for communication error status - this variable returns true when there is a communications error

	splitString2 = addr.split(',');  
	if (splitString2.length == 2) {
		theItem.arrayLength = parseInt(splitString2[1].replace(/[A-z]/gi, ''), 10);
	} else {
		theItem.arrayLength = 1;
	}

	splitString2[0] = splitString2[0].replace("/",".");
	var splitdot = splitString2[0].split('.');
	if (splitdot.length > 2) {
		outputLog("Error - String Couldn't Split Properly.  Only one dot or slash.");
		return undefined;
	}
	if (splitdot.length == 2)
	{
		postDotNumeric = parseInt(splitdot[1].replace(/[A-z]/gi, ''), 10);
		outputLog('PostDotNumeric is ' + postDotNumeric,2);
		splitString2[0] = splitdot[0];
	}

	theItem.offset = parseInt(splitString2[0].replace(/[A-z]/gi, ''), 10);

	// Get the data type from the second part.  
	prefix = splitString2[0].replace(/[0-9]/gi, '');

	// Octal switch
	if ((prefix === "X" || prefix === "Y") && octalInputOutput) {
		preOctalOffset = theItem.offset;
		theItem.offset = parseInt(theItem.offset.toString(),8);
		if (isNaN(theItem.offset)) {
			theItem.offset = preOctalOffset;
		}
	}

	switch (prefix) {
	case "DFLOAT":
		// These are the double-byte types
		theItem.addrtype = "D";
		theItem.datatype = "REAL";
		theItem.multidtypelen = 4;
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		theItem.dtypelen = 4;
		break;	
	case "DDINT":
		// These are the double-byte types
		theItem.addrtype = "D";
		theItem.datatype = "DINT";
		theItem.multidtypelen = 4;
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		theItem.dtypelen = 4;
		break;
	case "RFLOAT":
		// These are the double-byte types
		theItem.addrtype = "R";
		theItem.datatype = "REAL";
		theItem.multidtypelen = 4;
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		theItem.dtypelen = 4;
		break;	
	case "RDINT":
		// These are the double-byte types
		theItem.addrtype = "R";
		theItem.datatype = "DINT";
		theItem.multidtypelen = 4;
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		theItem.dtypelen = 4;
		break;		
	case "DSTR":
		// These are the double-byte types
		theItem.addrtype = "D";
		theItem.datatype = "CHAR";
		theItem.multidtypelen = 1;
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		theItem.dtypelen = 1;
		break;
	case "RSTR":
		// These are the double-byte types
		theItem.addrtype = "R";
		theItem.datatype = "CHAR";
		theItem.multidtypelen = 1;
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		theItem.dtypelen = 1;	
		break;		
	break;
	case "TN": // Current time value
	case "CN": // Current count value
	case "D":
	case "R":
		// These are the double-byte types
		theItem.addrtype = prefix;
		if (typeof(postDotNumeric) !== 'undefined') {
			theItem.datatype = 'X';
			theItem.bitOffset = postDotNumeric;
		} else {				
			theItem.datatype = "INT";
		}
		if (theItem.addrtype === "CN" && theItem.offset >= 200) {
			theItem.dtypelen = 4;
			theItem.multidtypelen = 4;		
			theItem.datatype = "DINT";			
		} else {
			theItem.dtypelen = 2;
			theItem.multidtypelen = 2;
		}
		theItem.remainder = 0;
		theItem.requestOffset = theItem.offset;
		break;
	case "TS":  // Timer Status (contact)
	case "CS":	// Counter Status (contact)
		theItem.addrtype = prefix;
		theItem.datatype = "X";
		theItem.multidtypelen = 2;
		theItem.remainder = theItem.offset % 16;
		theItem.requestOffset = theItem.offset - theItem.remainder;
		theItem.dtypelen = 2;
		break;
	case "X":
	case "Y":
	case "M":
	case "S":
		theItem.addrtype = prefix;
		theItem.datatype = "X";
		theItem.multidtypelen = 2;
		theItem.remainder = theItem.offset % 16;
		theItem.requestOffset = theItem.offset - theItem.remainder;
		theItem.dtypelen = 2;  // was 1, not sure why, we read 1 word at a time
		break;
	default:
		outputLog('Failed to find a match for ' + splitString2[0] + ' possibly because ' + prefix + ' type is not supported yet.');
		return undefined;
	}

	// bitNative indicates if we have a bit data type within the PLC.
	if (theItem.addrtype === "D" || theItem.addrtype === "R" || theItem.addrtype === "TN" || theItem.addrtype === "CN") {
		theItem.bitNative = false;
	} else {
		theItem.bitNative = true;
	}
	
	switch (theItem.addrtype) {
	case "D":	// Data
		theItem.areaMCCode = 0x4420;
//		theItem.maxWordLen = 64;
		break;
	case "R":	// Extension
		theItem.areaMCCode = 0x5220;
//		theItem.maxWordLen = 64;
		break;
	case "TN":	// Timer current value
		theItem.areaMCCode = 0x544e;
//		theItem.maxWordLen = 64;
		break;
	case "TS":	// Timer contact
		theItem.areaMCCode = 0x5453;
//		theItem.maxWordLen = 64;
		break;		
	case "CN":	// Counter current value
		theItem.areaMCCode = 0x434e;
//		theItem.maxWordLen = (depends on whether it's 32-bit (>200) or not, see FX3U-ENET-ADP manual)
		break;
	case "CS":	// Counter contact
		theItem.areaMCCode = 0x4353;
		break;	
	case "X":	// Input
		theItem.areaMCCode = 0x5820;
		break;	
	case "Y":	// Output
		theItem.areaMCCode = 0x5920; 
		break;	
	case "M":	// Auxiliary Relay
		theItem.areaMCCode = 0x4d20;
		break;	
	case "S":	// State
		theItem.areaMCCode = 0x5320;
		break;	
	default:
		outputLog('Failed to find a match for ' + theItem.addrtype + ' possibly because that type is not supported yet.');
		return undefined;
	}
	
	if (forceBitDtype) {
		theItem.datatype = "X";
	}
	
	// Save the address from the argument for later use and reference
	theItem.addr = addr;
	if (useraddr === undefined) {
		theItem.useraddr = addr;
	} else {
		theItem.useraddr = useraddr;	
	}

	if (theItem.datatype === 'X') {
		theItem.wordLength = Math.ceil((theItem.remainder + theItem.arrayLength) / 16);  // used tadd request offset here but not right
//		if (theItem.byteLength % 2) { theItem.byteLength += 1; }  // Always even for AB
	} else {
		theItem.wordLength = theItem.arrayLength * theItem.dataTypeByteLength()/2;
	}

	theItem.byteLength = theItem.wordLength*2;
	
	theItem.byteLengthWrite = (theItem.bitNative) ? Math.ceil(theItem.arrayLength/2) : theItem.byteLength;

	theItem.totalArrayLength = theItem.arrayLength;

	// Counter check - can't think of a better way to handle this.
	if (theItem.addrtype === "CN" && theItem.requestOffset < 200 && (theItem.requestOffset + theItem.arrayLength > 200)) {
		outputLog("IMPORTANT NOTE: You can't have a counter array that crosses the 200-point boundary.");
		return undefined;
	}
	
	return theItem;
}

function outputError(txt) {
	util.error(txt);
}

function decimalToHexString(number)
{
    if (number < 0)
    {
    	number = 0xFFFFFFFF + number + 1;
    }

    return "0x" + number.toString(16).toUpperCase();
}

function PLCPacket() {
	this.seqNum = undefined;				// Made-up sequence number to watch for.  
	this.itemList = undefined;  			// This will be assigned the object that details what was in the request.  
	this.reqTime = undefined;
	this.sent = false;						// Have we sent the packet yet?
	this.rcvd = false;						// Are we waiting on a reply?
	this.timeoutError = undefined;			// The packet is marked with error on timeout so we don't then later switch to good data. 
	this.timeout = undefined;				// The timeout for use with clearTimeout()
}

function PLCItem() { // Object
	// MC only
	this.areaMCCode = undefined;
	this.bitNative = undefined;
	this.startRegister = undefined;
	this.byteLengthWrite = undefined;
	
	// Save the original address
	this.addr = undefined;
	this.useraddr = undefined;

	// First group is properties to do with PLC item - these alone define the address.
	this.addrtype = undefined;
	this.datatype = undefined;
	this.bitOffset = undefined;
	this.byteOffset = undefined;
	this.offset = undefined;	
	this.arrayLength = undefined;
	this.totalArrayLength = undefined; 

	this.maxWordLength = function(isWriting) {
		if (typeof(this.addrtype) === 'undefined') {
			return 1;
		}
		switch (this.addrtype) {
		case "D":	// Data
		case "R":	// Extension
		case "TN":	// Timer current value
			return 64;
		case "CN":	// Counter current value
			if ((typeof(this.offset) === 'undefined') || (this.offset < 0)) {
				return 1;
			}
			if (this.offset >= 200) {
				return 32;		// Counters are 32 bit so take two words each
			}
			return Math.max(199 - this.offset, 64);  // Can't cross the 199-200 boundary for counters
		case "TS":	// Timer contact
		case "CS":	// Counter contact
		case "X":	// Input
		case "Y":	// Output
		case "M":	// Auxiliary Relay
		case "S":	// State
			return (isWriting) ? 40 : 16; // 160 points max when writing, 4 points per word = 40 words.  Otherwise 256 points max which is 16 words.
		default:
			outputLog('Failed to find a match for ' + theItem.addrtype + ' possibly because that type is not supported yet.');
			return undefined;
		}
	}

	this.dataTypeByteLength = function() {
		if (typeof(this.addrtype) === 'undefined') {
			return 1;
		}
		switch (this.addrtype) {
		case "D":	// Data
		case "R":	// Extension
			if (this.datatype === "REAL" || this.datatype === "DINT" || this.datatype === "DWORD") {
				return 4;
			} else if (this.datatype === "CHAR") {
				return 1;
			} else {
				return 2;
			}
		case "TN":	// Timer current value
			return 2;
		case "CN":	// Counter current value
			if ((typeof(this.offset) === 'undefined') || (this.offset < 0)) {
				return 1;
			}
			if (this.offset >= 200) {
				return 4;		// Counters are 32 bit so take two words each
			}
			return 2;  // Can't cross the 199-200 boundary for counters
		case "TS":	// Timer contact
		case "CS":	// Counter contact
		case "X":	// Input
		case "Y":	// Output
		case "M":	// Auxiliary Relay
		case "S":	// State
			return 1; 
		default:
			outputLog('Failed to find a match for ' + theItem.addrtype + ' possibly because that type is not supported yet.');
			return undefined;
		}
	}

	
	// These next properties can be calculated from the above properties, and may be converted to functions.
	this.dtypelen = undefined;
	this.multidtypelen = undefined; // multi-datatype length.  Different than dtypelen when requesting a timer preset, for example, which has width two but dtypelen of 2.
	this.areaMCCode = undefined;
	this.byteLength = undefined;
	this.byteLengthWithFill = undefined;
	
	// Note that read transport codes and write transport codes will be the same except for bits which are read as bytes but written as bits
	this.readTransportCode = undefined;
	this.writeTransportCode = undefined;

	// This is where the data can go that arrives in the packet, before calculating the value.  
	this.byteBuffer = new Buffer(8192);
	this.writeBuffer = new Buffer(8192);
	
	// We use the "quality buffer" to keep track of whether or not the requests were successful.  
	// Otherwise, it is too easy to lose track of arrays that may only be partially complete.  
	this.qualityBuffer = new Buffer(8192);
	this.writeQualityBuffer = new Buffer(8192);
	
	// Then we have item properties
	this.value = undefined;
	this.writeValue = undefined;
	this.valid = false;
	this.errCode = undefined;
	
	// Then we have result properties
	this.part = undefined;
	this.maxPart = undefined;
	
	// Block properties
	this.isOptimized = false;
	this.resultReference = undefined;
	this.itemReference = undefined;
	
	// And functions...
	this.clone = function() {
		var newObj = new PLCItem();
		for (var i in this) {
			if (i == 'clone') continue;
			newObj[i] = this[i];
		} return newObj;
	};

	
	// Bad value function definition
	this.badValue = function() {
		switch (this.datatype){
		case "REAL":
			return 0.0;
		case "DWORD":
		case "DINT":
		case "INT":
		case "WORD":
		case "B":
		case "BYTE":
			return 0;
		case "X":
			return false;
		case "C":
		case "CHAR":
			// Convert to string.  
			return "";
		default:
			outputLog("Unknown data type when figuring out bad value - should never happen.  Should have been caught earlier.  " + this.datatype);
			return 0;
		}
	};
}

function itemListSorter(a, b) {
	// Feel free to manipulate these next two lines...
	if (a.areaMCCode < b.areaMCCode) { return -1; }
	if (a.areaMCCode > b.areaMCCode) { return 1; }
	
	// But for byte offset we need to start at 0.  
	if (a.offset < b.offset) { return -1; }
	if (a.offset > b.offset) { return 1; }
	
	// Then bit offset
	if (a.bitOffset < b.bitOffset) { return -1; }
	if (a.bitOffset > b.bitOffset) { return 1; }

	// Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
	if (a.byteLength > b.byteLength) { return -1; }
	if (a.byteLength < b.byteLength) { return 1; }
}

function doNothing(arg) {
	return arg;
}

function getFloatBESwap(buf, ptr) {
	var newBuf = new Buffer(4);
	newBuf[0] = buf[ptr+2];
	newBuf[1] = buf[ptr+3];
	newBuf[2] = buf[ptr+0];
	newBuf[3] = buf[ptr+1];
	return newBuf.readFloatBE(0);
}

function setFloatBESwap(buf, ptr, val) {
	var newBuf = new Buffer(4);
	newBuf.writeFloatBE(val, 0);
	buf[ptr+2] = newBuf[0];
	buf[ptr+3] = newBuf[1];
	buf[ptr+0] = newBuf[2];
	buf[ptr+1] = newBuf[3];
	return;
}

function getInt32BESwap(buf, ptr) {
	var newBuf = new Buffer(4);
	newBuf[0] = buf[ptr+2];
	newBuf[1] = buf[ptr+3];
	newBuf[2] = buf[ptr+0];
	newBuf[3] = buf[ptr+1];
	return newBuf.readInt32BE(0);
}

function setInt32BESwap(buf, ptr, val) {
	var newBuf = new Buffer(4);
	newBuf.writeInt32BE(Math.round(val), 0);
	buf[ptr+2] = newBuf[0];
	buf[ptr+3] = newBuf[1];
	buf[ptr+0] = newBuf[2];
	buf[ptr+1] = newBuf[3];
	return;
}

function getUInt32BESwap(buf, ptr) {
	var newBuf = new Buffer(4);
	newBuf[0] = buf[ptr+2];
	newBuf[1] = buf[ptr+3];
	newBuf[2] = buf[ptr+0];
	newBuf[3] = buf[ptr+1];
	return newBuf.readUInt32BE(0);
}

function setUInt32BESwap(buf, ptr, val) {
	var newBuf = new Buffer(4);
	newBuf.writeUInt32BE(Math.round(val), 0);
	buf[ptr+2] = newBuf[0];
	buf[ptr+3] = newBuf[1];
	buf[ptr+0] = newBuf[2];
	buf[ptr+1] = newBuf[3];
	return;
}

function binarize(buf) {
	var i, newBuf;
	if (buf && !(buf.length % 2)) {
		newBuf = new Buffer(buf.length / 2);
		for (i=0;i<buf.length;i+=2) {
			newBuf[i/2] = parseInt("0x" + buf.toString('ascii',i,i+2));
			if (isNaN(newBuf[i/2])) { 
				return undefined;
			}
		}
		return newBuf;
	}
	return undefined;
}

function asciize(buf) {
	var i, newBuf;
	if (buf) {
		newBuf = new Buffer(buf.length * 2);
		for (i=0;i<buf.length;i+=1) {
			newBuf.write(zeroPad(buf[i],2), i*2, 2, 'ascii');
		}
		return newBuf;
	}
	return undefined;
}

function zeroPad(num, places) {
  var zero = places - num.toString(16).length + 1;
  return Array(+(zero > 0 && zero)).join("0") + num.toString(16);
}
