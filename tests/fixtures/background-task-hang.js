console.log('hang-start');
process.on('SIGTERM', () => {
  console.log('test stop');
  process.exit(0);
});
setInterval(() => {
  // keep alive for stop test
}, 1000);
