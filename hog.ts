import {
  brightRed,
  brightYellow,
  brightBlue,
} from "https://deno.land/std@0.95.0/fmt/colors.ts";
import { sprintf } from "https://deno.land/std@0.95.0/fmt/printf.ts";

type Pid = string;

const parseMemory = (mem: string) => {
  const match = mem.match(/^(\d+)(K|M|G)$/);
  if (!match) throw Error(`Could not parse memory ${mem}`);
  const scale =
    match[2] === "K"
      ? 1
      : match[2] === "M"
      ? 2 ** 10
      : match[2] === "G"
      ? 2 ** 20
      : 0;
  return parseInt(match[1], 10) * scale;
};

const nameMatchers = [
  /^\/Applications\/(.*?)(?:\.app)?\//,
  /^\/System\/Applications\/Utilities\/(.*?)(?:\.app)?\//,
  /^\/System\/Library\/[^ ]*\/([^ ]*)/,
  /^\/opt\/homebrew\/bin\/([^ ]*)/,
  /^\/usr\/[^ ]*\/([^ ]*)/,
  /^\/Library\/.*\/(.*?)(?:\.app)\//,
];
const shortName = (longName: string) => {
  for (const matcher of nameMatchers) {
    const match = longName.match(matcher);
    if (!match) continue;
    return match[1];
  }

  if (longName.includes(".vscode/extensions")) return "Visual Studio Code";
  if (longName.includes("Meeting Center.app")) return "Webex Meetings";

  return longName;
};

const applicationNames = async () => {
  const names = new Map<Pid, { longName: string; shortName: string }>();
  const process = Deno.run({
    cmd: ["ps", "ax"],
    stdout: "piped",
  });

  const lines = new TextDecoder().decode(await process.output()).split("\n");
  process.close();

  for (const line of lines) {
    if (skipping) {
      if (line.startsWith("PID")) skipping = false;
      continue;
    }
    if (line === "") continue;
    const [pid, , , , ...command] = line.trim().split(/\s+/);
    const longName = command.join(" ");
    names.set(pid, { longName, shortName: shortName(longName) });
  }

  return names;
};

// Get process memory usage
const process = Deno.run({
  cmd: ["top", "-stats", "ppid,pid,mem", "-l", "1"],
  stdout: "piped",
});

const lines = new TextDecoder().decode(await process.output()).split("\n");
process.close();

const processTree = new Map<
  string,
  { children: Set<string>; memory: number }
>();

let skipping = true;
for (const line of lines) {
  if (skipping) {
    if (line.startsWith("PPID")) skipping = false;
    continue;
  }
  if (line === "") continue;
  const [ppid, pid, mem] = line.split(/\s+/);
  const memory = parseMemory(mem);

  if (!processTree.has(ppid))
    processTree.set(ppid, { children: new Set(), memory: 0 });
  if (!processTree.has(pid))
    processTree.set(pid, { children: new Set(), memory: 0 });

  processTree.get(ppid)!.children.add(pid);
  processTree.get(pid)!.memory = memory;
}

// Sum up memory
const totalMemory = (pid: string) => {
  let sum = 0;
  const { children, memory } = processTree.get(pid)!;
  sum += memory;
  for (const child of children) sum += totalMemory(child);
  return sum;
};

// Get application names
const names = await applicationNames();

const applications = new Map<string, { memory: number; pids: Set<string> }>();
for (const pid of processTree.get("1")!.children) {
  const name = names.get(pid)!.shortName;
  if (!applications.has(name))
    applications.set(name, { memory: 0, pids: new Set() });
  applications.get(name)!.memory += totalMemory(pid);
  applications.get(name)!.pids.add(pid);
}

const formatMemory = (memory: number) => {
  if (memory > 2 ** 20 * 0.9)
    return brightRed(sprintf("%5.1f GB", memory / 2 ** 20));
  if (memory > 2 ** 10 * 150)
    return brightYellow(sprintf("%5.1f MB", memory / 2 ** 10));
  if (memory > 2 ** 10 * 0.95)
    return brightBlue(sprintf("%5.1f MB", memory / 2 ** 10));
  return brightBlue(sprintf("%5.1f KB", memory));
};

for (const [name, { memory }] of [...applications]
  .filter((a) => a[1].memory > 2 ** 10 * 50)
  .sort((a, b) => b[1].memory - a[1].memory)) {
  console.log(`${formatMemory(memory)} ${name}`);
}
