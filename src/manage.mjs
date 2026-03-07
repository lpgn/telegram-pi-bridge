import {
  AUDIT_LOG,
  OUT_LOG,
  getStatus,
  readLogTail,
  restartBridge,
  startBridge,
  stopBridge,
} from "./manager-lib.mjs";

const command = (process.argv[2] || "status").toLowerCase();

switch (command) {
  case "start":
    await printResult(await startBridge());
    break;
  case "stop":
    await printResult(await stopBridge());
    break;
  case "restart":
    await printResult(await restartBridge());
    break;
  case "status":
    printStatus(await getStatus());
    break;
  case "logs": {
    const which = (process.argv[3] || "bridge").toLowerCase();
    const target = which === "audit" ? AUDIT_LOG : OUT_LOG;
    process.stdout.write(await readLogTail(target));
    break;
  }
  default:
    console.log("Usage: node src/manage.mjs [start|stop|restart|status|logs [bridge|audit]]");
    process.exitCode = 1;
}

async function printResult(result) {
  console.log(result.message);
  printStatus(result.status);
}

function printStatus(status) {
  console.log(`running: ${status.running ? "yes" : "no"}`);
  console.log(`pid: ${status.pid ?? "-"}`);
  console.log(`bridge log: ${status.outLog.path} (${status.outLog.size} bytes)`);
  console.log(`audit log: ${status.auditLog.path} (${status.auditLog.size} bytes)`);
}
