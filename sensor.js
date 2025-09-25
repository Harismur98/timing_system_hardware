const { SerialPort } = require('serialport');

const port = new SerialPort({
  path: 'COM3',     // change to your actual port
  baudRate: 38400
});


// Read data that is available but keep the stream in "paused mode"
port.on('readable', function () {

    const buffer = port.read();  // <-- read once
    if (!buffer) return;
    console.log(buffer);
    const hexArray = Array.from(buffer, byte => byte.toString(16).padStart(2, '0').toUpperCase());

    if (hexArray[0] == '02' || hexArray[2] == '41') {

        const header = hexArray[0];
        const addressCode = hexArray[1];
        const commandCode = hexArray[2];
        const length = hexArray[3];

        const cardIdHex = hexArray.slice(4, 7).join('');
        const cardId = parseInt(cardIdHex, 16);

        const voltageHex = hexArray[7];
        const voltage = parseInt(voltageHex, 16) / 10;

        const senseId = hexArray.slice(8, 10).join(' ');
        const signalStrength = hexArray[10];

        const checksum = parseInt(hexArray[11], 16);
        const calculatedXOR = hexArray.slice(0, 11).reduce(
        (xor, val) => xor ^ parseInt(val, 16),0);

        console.log(`Header        : ${header}`);
        console.log(`Address Code  : ${addressCode}`);
        console.log(`Command Code  : ${commandCode}`);
        console.log(`Length        : ${length}`);
        console.log(`Card ID       : ${cardId}`);
        console.log(`Card Voltage     : ${voltage.toFixed(1)} V`);
        console.log(`Sense ID      : ${senseId}`);
        console.log(`Signal Strength: ${signalStrength}`);
        console.log(`Checksum OK   : ${checksum === calculatedXOR}`);
        console.log('---------------------------');
    }

    if (hexArray.length === 8 && hexArray[0] === '01') {
        const voltage = parseInt(hexArray[1] + hexArray[2], 16) / 10;  // EA → 234 → 23.4V
        const current = parseInt(hexArray[3] + hexArray[4], 16);       // 00 32 → 50 mA

        let tempVal = parseInt(hexArray[5] + hexArray[6], 16);
        let temp = tempVal & 0xFF; // bitwise technique 0xFF = 255 in decimal = 11111111 in binary. We want to remove the first byte since it can mess up the convertion
        const isNegative = hexArray[5].toUpperCase() === 'FF';
        if (isNegative) temp = -temp;

        const checksum = parseInt(hexArray[7], 16);
        const xorCalc = hexArray.slice(0, 7).reduce((acc, h) => acc ^ parseInt(h, 16), 0);

        console.log(`Voltage (V): ${voltage}`);
        console.log(`Current (mA): ${current}`);
        console.log(`Temperature (°C): ${temp}`);
        console.log(`Checksum OK: ${checksum === xorCalc}`);
        console.log('============================');
    }

})

