const path = require('node:path');
const { R8Runtime } = require(path.resolve(process.argv[2], 'dist/src/r7/integration/runtime.js'));

function assigned(rt, type) {
  const actor = Object.keys(rt.world.npcs)[0];
  rt.dispatch('tasks', 'propose', actor, {type, assigneeId: actor});
  const task = rt.states.tasks.tasks.at(-1);
  rt.dispatch('tasks', 'respond', actor, {taskId: task.taskId, verdict: 'accept'});
  return {actor, taskId: task.taskId};
}
const forged = R8Runtime.create({seed:'audit-forged-receipt'});
const a = assigned(forged, 'COLLECT_FOOD');
const foodBefore = forged.world.resources.food;
const timeBefore = forged.world.simTime;
const result = forged.dispatch('tasks','complete',a.actor,
  {taskId:a.taskId,receiptEventId:'this-event-does-not-exist'});
console.log(JSON.stringify({probe:'invented_receipt',foodBefore,foodAfter:forged.world.resources.food,
  timeBefore,timeAfter:forged.world.simTime,status:forged.states.tasks.tasks.at(-1).status,
  applied:result.applied,rejected:result.rejected}));

const build = R8Runtime.create({seed:'audit-build-receipt'});
const b = assigned(build,'BUILD_GENERATOR');
const started = build.dispatch('production','build-machine',b.actor,{machine:'generator'});
const acceptedReceipt = started.events[0]?.eventId;
const completed = build.dispatch('tasks','complete',b.actor,
  {taskId:b.taskId,receiptEventId:acceptedReceipt});
console.log(JSON.stringify({probe:'build_start_as_completion',receipt:acceptedReceipt,
  elapsed:build.elapsed(),taskStatus:build.states.tasks.tasks.at(-1).status,
  machine:build.world.r8.machines.generator,remaining:build.states.production.buildRemaining.generator,
  rejected:completed.rejected}));

const stopped = R8Runtime.create({seed:'audit-restart',resources:{firewood:12}});
const actor = Object.keys(stopped.world.npcs)[0];
stopped.dispatch('production','build-machine',actor,{machine:'generator'});
stopped.advanceWorld(480+300);
const before = {machine:stopped.world.r8.machines.generator,wood:stopped.world.resources.firewood};
const refill = stopped.session.submitWorldCommand({commandId:'audit-refill',type:'gather',actorId:actor,
  resource:'firewood',amount:10});
const refilled = stopped.world.resources.firewood;
stopped.advanceWorld(stopped.world.simTime+60);
const restart = stopped.dispatch('production','start-machine',actor,{machine:'generator'});
console.log(JSON.stringify({probe:'stopped_machine_refilled',before,refillStatus:refill.status,
  refilled,after:{machine:stopped.world.r8.machines.generator,wood:stopped.world.resources.firewood},
  startCommand:restart}));
