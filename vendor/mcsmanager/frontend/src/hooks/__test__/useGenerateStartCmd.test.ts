// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useStartCmdBuilder } from "../useGenerateStartCmd";
describe("Minecraft launch command", () => {
  it("quotes paths and applies configured Java arguments", () => {
    const { minecraftJava, buildCmd } = useStartCmdBuilder();
    Object.assign(minecraftJava.value, {
      javaPath: "C:/Program Files/Java/bin/java.exe",
      jarName: "modded server.jar",
      maxMemory: "4G",
      minMemory: "1G",
      additional: "-Dcustom=true",
      suffix: "nogui"
    });
    expect(buildCmd()).toBe(
      '"C:/Program Files/Java/bin/java.exe" -Xms1G -Xmx4G -Dcustom=true -jar "modded server.jar" nogui'
    );
  });
  it("keeps independent configuration for each form", () => {
    const first = useStartCmdBuilder();
    const second = useStartCmdBuilder();
    first.minecraftJava.value.jarName = "first.jar";
    expect(second.minecraftJava.value.jarName).toBe("");
  });
});
