import { ref } from "vue";

export function useStartCmdBuilder() {
  const [language, country] = navigator.language.split("-");
  const additional = ["-Dfile.encoding=UTF-8"];
  if (language) additional.push("-Duser.language=" + language);
  if (country) additional.push("-Duser.country=" + country);
  const minecraftJava = ref({
    javaPath: "",
    jarName: "",
    maxMemory: "",
    minMemory: "",
    suffix: "nogui",
    additional: additional.join(" ")
  });
  const buildCmd = () => {
    const config = minecraftJava.value;
    const command = [config.javaPath ? '"' + config.javaPath + '"' : "java"];
    if (config.minMemory) command.push("-Xms" + config.minMemory);
    if (config.maxMemory) command.push("-Xmx" + config.maxMemory);
    if (config.additional) command.push(config.additional);
    command.push("-jar", '"' + config.jarName + '"', config.suffix);
    return command.join(" ");
  };
  return { minecraftJava, buildCmd };
}
