module.exports.simulateRandomFailure = (failureRate) => {
    const randomValue = Math.random();
    console.log(`Random failure check: ${randomValue.toFixed(3)} < ${failureRate} = ${randomValue < failureRate}`);
    if (randomValue < failureRate) {
      throw new Error(`Simulated task failure (random: ${randomValue.toFixed(3)})`);
    }
  };
  