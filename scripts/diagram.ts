// Writes docs/state-machine.md from the state machine's RULES.
import { writeFileSync } from "node:fs";
import { renderStateDiagram } from "../src/domain/diagram";

writeFileSync("docs/state-machine.md", renderStateDiagram());
console.log("wrote docs/state-machine.md");
