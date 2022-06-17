import {
  brightRed,
  brightYellow,
  brightBlue,
  gray,
} from "https://deno.land/std@0.143.0/fmt/colors.ts";
import { sprintf } from "https://deno.land/std@0.143.0/fmt/printf.ts";
import { parse } from "https://deno.land/std@0.143.0/flags/mod.ts";

type Pid = string;

const parseMemory = (mem: string) => {
  const match = mem.match(/^(\d+)(K|M|G)[-+]?$/);
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

  let skipping = true;
  for (const line of lines) {
    if (skipping) {
      if (line.trimStart().startsWith("PID")) skipping = false;
      continue;
    }
    if (line === "") continue;
    const [pid, , , , ...command] = line.trim().split(/\s+/);
    const longName = command.join(" ");
    names.set(pid, { longName, shortName: shortName(longName) });
  }

  return names;
};

// Get usage
const getProcessTree = async ({ samples = 1 }: { samples?: number }) => {
  const process = Deno.run({
    cmd: ["top", "-stats", "ppid,pid,mem,cpu", "-a", "-l", String(samples)],
    stdout: "piped",
  });

  const lines = new TextDecoder().decode(await process.output()).split("\n");
  process.close();

  const processTree = new Map<
    string,
    { children: Set<string>; memory: number; cpu: number }
  >();

  let skipping = true;
  let skippedSamples = 0;
  for (const line of lines) {
    if (skipping) {
      if (line.startsWith("PPID")) {
        skippedSamples++;
        if (skippedSamples === samples) skipping = false;
      }
      continue;
    }
    if (line === "") continue;

    const [ppid, pid, memory, cpu] = line.split(/\s+/);

    if (!processTree.has(ppid))
      processTree.set(ppid, { children: new Set(), memory: 0, cpu: 0 });
    if (!processTree.has(pid))
      processTree.set(pid, { children: new Set(), memory: 0, cpu: 0 });

    processTree.get(ppid)!.children.add(pid);
    processTree.get(pid)!.memory = parseMemory(memory);
    processTree.get(pid)!.cpu = parseFloat(cpu);
  }

  return processTree;
};

// Get application names
const getApplications = async ({ samples }: { samples?: number } = {}) => {
  const [names, processTree] = await Promise.all([
    applicationNames(),
    getProcessTree({ samples }),
  ]);

  // Sum up memory
  const totalMemory = (pid: string) => {
    let sum = 0;
    const { children, memory } = processTree.get(pid)!;
    sum += memory;
    for (const child of children) sum += totalMemory(child);
    return sum;
  };

  // Sum up cpu
  const totalCpu = (pid: string) => {
    let sum = 0;
    const { children, cpu } = processTree.get(pid)!;
    sum += cpu;
    for (const child of children) sum += totalCpu(child);
    return sum;
  };

  const applications = new Map<
    string,
    { memory: number; cpu: number; pids: Set<string> }
  >();
  for (const pid of processTree.get("1")!.children) {
    const name = names.get(pid)?.shortName;
    if (name == null) continue;
    if (!applications.has(name))
      applications.set(name, { memory: 0, cpu: 0, pids: new Set() });
    applications.get(name)!.memory += totalMemory(pid);
    applications.get(name)!.cpu += totalCpu(pid);
    applications.get(name)!.pids.add(pid);
  }
  return applications;
};

const formatMemory = (memory: number) => {
  if (memory > 2 ** 20 * 0.9)
    return brightRed(sprintf("%5.1f GB", memory / 2 ** 20));
  if (memory > 2 ** 10 * 150)
    return brightYellow(sprintf("%5.1f MB", memory / 2 ** 10));
  if (memory > 2 ** 10 * 0.95)
    return brightBlue(sprintf("%5.1f MB", memory / 2 ** 10));
  return brightBlue(sprintf("%5.1f KB", memory));
};

const formatCpu = (cpu: number) => {
  if (cpu > 80) return brightRed(sprintf("%5.1f %%", cpu));
  if (cpu > 30) return brightYellow(sprintf("%5.1f %%", cpu));
  return brightBlue(sprintf("%5.1f %%", cpu));
};

const args = parse(Deno.args);
const mode = args._[0] === "cpu" ? "cpu" : "memory";

if (mode === "cpu") {
  for (const [name, { cpu, pids }] of [
    ...(await getApplications({
      samples: args.s ? parseInt(args.s, 10) : 4,
    })),
  ]
    .filter((a) => a[1].cpu > 1)
    .sort((a, b) => b[1].cpu - a[1].cpu)) {
    console.log(
      `${formatCpu(cpu)}  ${name}` +
        (args.p ? ` ${gray("(" + [...pids].join(", ") + ")")}` : "")
    );
  }
} else {
  for (const [name, { memory, pids }] of [...(await getApplications())]
    .filter((a) => a[1].memory > 2 ** 10 * 50)
    .sort((a, b) => b[1].memory - a[1].memory)) {
    console.log(
      `${formatMemory(memory)}  ${name}` +
        (args.p ? ` ${gray("(" + [...pids].join(", ") + ")")}` : "")
    );
  }
}
