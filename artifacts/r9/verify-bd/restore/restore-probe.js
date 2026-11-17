const { R8Runtime } = require(process.argv[2]);
const mode = process.argv[3];
const save = process.argv[4];
if (mode === 'save') {
  const rt = R8Runtime.create({ seed: 'restore-1' });
  rt.advanceWorld(480 + 24 * 60);
  rt.save(save);
  console.log(JSON.stringify({ wrote: true, elapsed: rt.elapsed(),
    clock: rt.world.simTime, version: rt.world.version }));
} else {
  const rt = R8Runtime.load(save);
  console.log(JSON.stringify({ loaded: true, elapsed: rt.elapsed(),
    clock: rt.world.simTime, version: rt.world.version }));
}