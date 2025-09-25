const { SerialPort } = require("serialport");

SerialPort.list().then(ports => {
  if (!ports.length) {
    console.log("No serial ports found");
  } else {
    console.log("Available serial ports:");
    ports.forEach(p => {
      console.log(`${p.path} - ${p.manufacturer || "Unknown"}`);
    });
  }
});
