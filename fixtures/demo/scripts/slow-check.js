// A check that runs long enough to be cut off. One line per second; SLOW_CHECK_SECONDS sets the length.
const seconds = Number(process.env.SLOW_CHECK_SECONDS ?? 300);
let done = 0;
const timer = setInterval(() => {
  done += 1;
  console.log(`slow-check: ${done}/${seconds}s`);
  if (done >= seconds) {
    clearInterval(timer);
    console.log("slow-check: ok");
  }
}, 1000);
