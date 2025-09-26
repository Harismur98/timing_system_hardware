const { SerialPort } = require('serialport');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const logStream = fs.createWriteStream('frames.log', { flags: 'a' });
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // serve frontend

// SerialPort setup
const port = new SerialPort({
  path: 'COM3',
  baudRate: 38400
});

// Buffers & racer data
let buffer = Buffer.alloc(0);
let racers = {}; // cardId → { laps, hits, times, etc. }
let RACE_MODE = 1; // default mode: 1 = fastest finisher, 2 = lowest total time

// Race settings
const HIT_TIMEOUT = 200;   // ms between passes = new lap
const PASS_GAP = 10000;    // ms required to count a new lap
const TOTAL_LAPS = 5;      // laps to finish

// Serial data handling
port.on('data', (chunk) => {
  logFrame(`Received chunk: ${chunk.toString('hex').toUpperCase()}`);
  buffer = Buffer.concat([buffer, chunk]);
  logFrame(`Buffer length: ${buffer.length}, Buffer: ${buffer.toString('hex').toUpperCase()}`);

  let frames = []; // Every new chunk come in we reset the frames

  // while (buffer.length > 0) {
  //   if (buffer[0] === 0x02) {
  //     // dynamic length frame
  //     if (buffer.length < 4) break;

  //     const expectedLength = buffer[3] + 1 + 8;
  //     if (buffer.length < expectedLength) break;

  //     const frame = buffer.slice(0, expectedLength);  
  //     frames.push(frame);
  //     buffer = buffer.slice(expectedLength);

  //   } else if (buffer[0] === 0x01) {
  //     // short fixed frame
  //     if (buffer.length < 8) break;

  //     const frame = buffer.slice(0, 8);
  //     frames.push(frame);
  //     buffer = buffer.slice(8);

  //   } else {
  //     // discard junk byte
  //     buffer = buffer.slice(1);
  //   }
  // }
  while (buffer.length > 0) {
    // Parse frames from buffer:
    // - Keep looping while buffer has data
    // - If first byte = 0x02 → treat as long frame (12 bytes)
    //   • If not enough bytes yet, wait for more (break)
    //   • Else slice out 12 bytes, push to frames[], remove from buffer
    // - Else if first byte = 0x01 → treat as short frame (8 bytes)
    //   • If not enough bytes yet, wait for more (break)
    //   • Else slice out 8 bytes, push to frames[], remove from buffer
    // - Else → first byte is junk → discard 1 byte and continue
        if (buffer[0] === 0x02) {
            const expectedLength = 12; 
            if (buffer.length < expectedLength) break;

            frames.push(buffer.slice(0, expectedLength));
            buffer = buffer.slice(expectedLength);

        } else if (buffer[0] === 0x01) {
            const expectedLength = 8; 
            if (buffer.length < expectedLength) break;

            frames.push(buffer.slice(0, expectedLength));
            buffer = buffer.slice(expectedLength);

        } else {
            buffer = buffer.slice(1); // junk discard
        }
    }
  // process frames
  while (frames.length > 0) {
    const frame = frames.shift();
    processFrame(frame);
  }
});

function processFrame(frame){

  if (!verifyChecksum(frame)) {
    logFrame(`Invalid checksum: ${frame.toString('hex').toUpperCase()}`);
    return; // ignore corrupted frame
  }
  
  const hexArray = Array.from(frame, byte =>
    byte.toString(16).padStart(2, '0').toUpperCase()
  );

  if (hexArray[0] === '02') {
    const cardIdHex = hexArray.slice(4, 7).join('');
    const cardId = parseInt(cardIdHex, 16);

    if (cardId === 0) return; // ignore card ID 0
    updateRacer(cardId);
    logFrame(`Raw: ${hexArray.join(' ')} | CardID: ${cardId}`);
  }

  //you can put code to process 01 here
}

function updateRacer(cardId) {
  const now = Date.now();
  let r = racers[cardId];

  if (!r) {
    r = {
      laps: 0,
      hits: 0,
      hitsThisLap: 0,
      lapHits: [],
      lastSeen: now,
      lastLapCross: 0,
      lastLapTime: 0,
      totalTime: 0,
      times: [],
      bestLap: null
    };
    racers[cardId] = r;
  }

  // increment hits
  r.hits++; 
  r.hitsThisLap++;
  r.lastSeen = now;

  // check if enough time passed since last lap crossing
  if (now - r.lastLapCross > PASS_GAP) {
    if (r.laps > 0) {
      // lap completed
      const lapTime = now - r.lastLapCross;
      r.lastLapTime = lapTime;
      r.totalTime += lapTime;
      r.times.push(lapTime);

      // save hits for this lap
      r.lapHits.push(r.hitsThisLap);
      r.hitsThisLap = 0;

      // update best lap
      if (!r.bestLap || lapTime < r.bestLap.time) {
        r.bestLap = {
          lap: r.laps,     // this lap number
          time: lapTime,    // lap time
          timeformated: format_time(lapTime)
        };
      }
    }

    r.laps++;
    r.lastLapCross = now;
  }

  // Recalculate leaderboard
    const leaderboard = getLeaderboard();
    io.emit('update', { racers: leaderboard });

    // Finish condition
    if (r.laps >= TOTAL_LAPS) {
    if (RACE_MODE === 1) {
      // Mode 1: first finisher wins
      const leaderboard = getLeaderboard();
      io.emit('finish', { results: leaderboard });
    } else if (RACE_MODE === 2) {
      // Mode 2: wait until ALL racers finish
      const allFinished = Object.values(racers).every(r => r.laps >= TOTAL_LAPS);
      if (allFinished) {
        const leaderboard = getLeaderboard();
        io.emit('finish', { results: leaderboard });
      }
    }
      else if (RACE_MODE === 3) {
      // Mode 3: lowest single lap time → we can end once all racers have at least 1 lap
      const allHaveLap = Object.values(racers).every(r => r.bestLap);
      if (allHaveLap) {
        const leaderboard = getLeaderboard();
        io.emit('finish', { results: leaderboard });
      }
    }
  }
}

function getLeaderboard() {
  const arr = Object.entries(racers).map(([cardId, r]) => ({
    cardId: parseInt(cardId),
    ...r
  }));

  arr.sort((a, b) => {
    if (RACE_MODE === 1) {
      // Mode 1: prioritize laps, then total time
      if (b.laps !== a.laps) return b.laps - a.laps;
      return a.totalTime - b.totalTime;
    } else if(RACE_MODE === 2){
      // Mode 2: prioritize lowest total lap time (among finished)
      const aDone = a.laps >= TOTAL_LAPS;
      const bDone = b.laps >= TOTAL_LAPS;
      if (aDone && !bDone) return -1;
      if (!aDone && bDone) return 1;
      return a.totalTime - b.totalTime;
    }
     else if(RACE_MODE === 3) {
    // Mode 3: lowest single lap wins
    const aBest = a.bestLap ? a.bestLap.time : Infinity;
    const bBest = b.bestLap ? b.bestLap.time : Infinity;
    return aBest - bBest;
  }
  });

  // let leaderTime = arr.length > 0 ? arr[0].totalTime : 0;
  let leaderValue = 0;

  if (arr.length > 0) {
    if (RACE_MODE === 3) {
      leaderValue = arr[0].bestLap ? arr[0].bestLap.time : 0;
    } else {
      leaderValue = arr[0].totalTime;
    }
  }
  return arr.map((r, i) => {
  let gapToLeader, interval, gapToLeaderFormatted, intervalFormatted;

  if (RACE_MODE === 3) {
    // Best lap mode
    const best = r.bestLap ? r.bestLap.time : Infinity;
    const prevBest = i > 0 && arr[i - 1].bestLap ? arr[i - 1].bestLap.time : best;

    gapToLeader = best - leaderValue;
    interval = i === 0 ? 0 : best - prevBest;

    gapToLeaderFormatted = format_time(gapToLeader);
    intervalFormatted = format_time(interval);

  } else {
    // Race by laps / total time
    const leader = arr[0];
    const lapDiff = leader.laps - r.laps;

    if (lapDiff > 0) {
      // behind in laps
      gapToLeaderFormatted = `+${lapDiff} Lap${lapDiff > 1 ? 's' : ''}`;
      intervalFormatted = gapToLeaderFormatted;
    } else {
      // same lap → use time
      gapToLeader = r.totalTime - leader.totalTime;
      interval = i === 0 ? 0 : r.totalTime - arr[i - 1].totalTime;

      gapToLeaderFormatted = format_time(gapToLeader);
      intervalFormatted = format_time(interval);
    }
  }

  return {
    ...r,
    gapToLeader,
    interval,
    position: i + 1,
    lastLapTimeFormatted: format_time(r.lastLapTime),
    totalTimeFormatted: format_time(r.totalTime),
    gapToLeaderFormatted,
    intervalFormatted,
  };
});

}

// Handle frontend connections
io.on('connection', (socket) => {
  console.log('Client connected');  

  // Send current mode to new client
  socket.emit('mode', { raceMode: RACE_MODE });

  // Listen for mode changes
  socket.on('setMode', (data) => {
    if (data.raceMode === 1 || data.raceMode === 2 || data.raceMode === 3) {
      RACE_MODE = data.raceMode;
      console.log(`Race mode changed to ${RACE_MODE}`);
      io.emit('mode', { raceMode: RACE_MODE });
    }
  });

  // Reset race 
  socket.on('resetRace', () => {
    racers = {};
    console.log('Race reset');
    io.emit('update', { racers: [] });
  });

    socket.on('resetRace', () => {
    // reset race state
    racers = [];
    raceInProgress = false;
    startTime = null;

    // update all clients
    io.emit('update', { racers: [] });
    io.emit('finish', { results: [] }); // clear results table
  });
});

function logFrame(message) {
  const timestamp = new Date().toISOString();
  logStream.write(`[${timestamp}] ${message}\n`);
}

function format_time(ms) {
  if (!ms || !isFinite(ms)) {
    return "00:00.000";
  }
  const minutes = Math.floor(ms / 60000); // 1 min = 60000 ms
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;

  return `${String(minutes).padStart(2, '0')}:` +
         `${String(seconds).padStart(2, '0')}.` +
         `${String(milliseconds).padStart(3, '0')}`;
}

function verifyChecksum(frame) {
  if (frame.length < 2) return false;

  const checksum = frame[frame.length - 1]; // last byte
  const calc = frame.slice(0, frame.length - 1)
                    .reduce((acc, b) => acc ^ b, 0);

  return checksum === calc;
}

server.listen(3000, () => {
  console.log('Dashboard running at http://localhost:3000');
}); 
