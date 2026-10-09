import { ChildProcess, spawn } from "child_process";
import EventEmitter from "events";
import fs from "fs-extra";
import { killProcess } from "mcsmanager-common";
import { $t } from "../../../i18n";
import logger from "../../../service/log";
import { getRunAsUserParams } from "../../../tools/system_user";
import Instance from "../../instance/instance";
import { IInstanceProcess } from "../../instance/interface";
import { commandStringToArray } from "../base/command_parser";
import AbsStartCommand from "../start";
import { HostingSession, settingsForInstance } from "../../../service/nomad";

// Error exception at startup
class StartupError extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

// General (non-Docker) child process adapter
class ProcessAdapter extends EventEmitter implements IInstanceProcess {
  pid?: number | string;

  constructor(private process: ChildProcess) {
    super();
    this.pid = this.process.pid;
    process.stdout?.on("data", (text) => this.emit("data", text));
    process.stderr?.on("data", (text) => this.emit("data", text));
    process.on("exit", (code) => this.emit("exit", code));
  }

  public write(data?: string) {
    return this.process.stdin?.write(data);
  }

  public kill(s?: any) {
    if (this.pid) return killProcess(this.pid, this.process, s);
  }

  public async destroy() {
    // remove all dynamically added event listeners
    for (const n of this.eventNames()) this.removeAllListeners(n);
    if (this.process.stdout)
      for (const eventName of this.process.stdout.eventNames())
        this.process.stdout.removeAllListeners(eventName);
    if (this.process.stderr)
      for (const eventName of this.process.stderr.eventNames())
        this.process.stderr.removeAllListeners(eventName);
    if (this.process)
      for (const eventName of this.process.eventNames()) this.process.removeAllListeners(eventName);
    this.process?.stdout?.destroy();
    this.process?.stderr?.destroy();
    if (this.process?.exitCode === null) {
      this.process.kill("SIGTERM");
      this.process.kill("SIGKILL");
    }
  }
}

export default class GeneralStartCommand extends AbsStartCommand {
  async createProcess(instance: Instance, source = "") {
    if (!instance.config.ie || !instance.config.oe) {
      instance.config.ie = "utf-8";
      instance.config.oe = "utf-8";
    }
    if (
      (!instance.config.startCommand && instance.config.processType === "general") ||
      !instance.hasCwdPath()
    )
      throw new StartupError($t("TXT_CODE_general_start.instanceConfigErr"));
    if (!fs.existsSync(instance.absoluteCwdPath())) fs.mkdirpSync(instance.absoluteCwdPath());

    // command parsing
    const tmpStartCmd = await instance.parseTextParams(instance.config.startCommand);
    const commandList = commandStringToArray(tmpStartCmd);
    const commandExeFile = commandList[0];
    const commandParameters = commandList.slice(1);
    if (commandList.length === 0) {
      throw new StartupError($t("TXT_CODE_general_start.cmdEmpty"));
    }

    // ── NomadCraft coordination ───────────────────────────────────────────────
    //
    // Before a single byte of game runs, this machine must hold the lease for this
    // world and its working directory must be the committed world. Only the lease
    // holder is allowed to open the save; anyone else is refused rather than allowed
    // to fork the world.
    const settings = settingsForInstance(instance.instanceUuid, instance.config);
    const session = new HostingSession(settings, {
      onProgress: (message) => instance.println("INFO", message)
    });

    if (settings.enabled) {
      const outcome = await session.begin(instance.absoluteCwdPath());
      if (outcome.kind === "busy") {
        throw new StartupError(
          "另一个玩家正在运行这个世界；请先让对方停止，或等待租约到期后再试。"
        );
      }
      if (outcome.kind === "granted") {
        session.bind(instance.absoluteCwdPath(), outcome.epoch);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const runAsConfig = await getRunAsUserParams(instance);

    logger.info("----------------");
    logger.info($t("TXT_CODE_general_start.startInstance", { source: source }));
    logger.info($t("TXT_CODE_general_start.instanceUuid", { uuid: instance.instanceUuid }));
    logger.info($t("TXT_CODE_general_start.startCmd", { cmdList: JSON.stringify(commandList) }));
    logger.info($t("TXT_CODE_general_start.cwd", { cwd: instance.absoluteCwdPath() }));
    logger.info($t("TXT_CODE_general_start.runAs", { user: runAsConfig.runAsName }));
    logger.info("----------------");

    if (runAsConfig.isEnableRunAs) {
      instance.println("INFO", $t("TXT_CODE_ba09da46", { name: runAsConfig.runAsName }));
    }

    // create child process
    const subProcess = spawn(commandExeFile, commandParameters, {
      ...runAsConfig,
      cwd: instance.absoluteCwdPath(),
      stdio: "pipe",
      windowsHide: true,
      env: instance.generateEnv(),
      // Do not detach the child process;
      // otherwise, an abnormal exit of the parent process may cause the child process to continue running,
      // leading to an abnormal instance state.
      detached: false
    });

    // child process creation result check
    if (!subProcess || !subProcess.pid) {
      instance.println(
        "ERROR",
        $t("TXT_CODE_general_start.pidErr", {
          startCommand: instance.config.startCommand,
          commandExeFile: commandExeFile,
          commandParameters: JSON.stringify(commandParameters)
        })
      );
      // The lease was won but the game never launched; hand it straight back so
      // another machine can recover instead of waiting for the lease to expire.
      await session.finish();
      throw new StartupError($t("TXT_CODE_general_start.startErr"));
    }

    // create process adapter
    const processAdapter = new ProcessAdapter(subProcess);

    // The relay slot and the checkpoint cadence begin only once the process exists.
    if (settings.enabled) {
      session.serve();
      subProcess.once("exit", () => {
        void session.finish();
      });
    }

    // generate open event
    instance.started(processAdapter);
    logger.info(
      $t("TXT_CODE_general_start.startSuccess", {
        instanceUuid: instance.instanceUuid,
        pid: subProcess.pid
      })
    );
    instance.println("INFO", $t("TXT_CODE_general_start.startOrdinaryTerminal"));
    instance.println("INFO", $t("TXT_CODE_b50ffba8"));
  }
}
