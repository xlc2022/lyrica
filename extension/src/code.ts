/** Principle 8: five lines shared by code-mode turns and the coder role. */
export const CODE_GUIDELINES = `Read the repository instructions and relevant files before editing. Follow the surrounding code’s naming, style and comment density, and check that a library is already used before importing it.
Run the repository’s checks after each change, each kind of test with the runner its instructions name (npm test may not run them all); start servers in the background with a time limit.
Read a failing log before changing anything.
Keep diffs small and focused on the task: put screenshots, logs and other check output in your scratch folder (/workspace, outside worktrees/), never in a repository, and commit only the work asked for. Before saying done, run git status in each repository or worktree you changed: commit what belongs to the work, or say what is left uncommitted and why.
Check what the request literally asked for (a single-file page opened from disk with no network, say); report which check ran, what it showed and what remains unchecked: a check that failed, never ran or ran before your last change isn't done.`;
export const CODING_GUIDELINE = "For a coding job outside a project chat, code in this thread: before your first edit, however small the change, turn on code mode (threads code, with task and done), and turn it off (on: false) when the coding is done. "
  + "Start a code: true thread only if the user asks for one. Delegate a small change on the side to the coder role. "
  + "Requested code children get their own worktrees and branches; keep the base and merge their branches here, starting a merge thread only if the user asks for one.";
/**
 * Execution rules for models that stop on a plan, answer from memory or fill in results they didn't get
 * (seen on the local models in the code-mode runs; hermes-agent gives its open-weight and GPT models the same).
 * Claude models don't need them, so they don't pay for them.
 */
export const EXECUTION_GUIDELINES = `Every reply either calls a tool that moves the work on or gives the final result: never end a reply on a plan or a promise.
Read file contents, git state, test results, dates and sums with a tool, never from memory.
If a tool, install or check fails and blocks the real path, say so and try another way; never write output, data or results you didn't get.`;
/** Whether a model gets EXECUTION_GUIDELINES: every model but Claude, by its ID or name. */
export function needsExecutionGuidelines(model: { id?: string; name?: string } | undefined): boolean {
  return !/claude/i.test(`${model?.id ?? ""} ${model?.name ?? ""}`);
}
/** Added once to the first edit or write while code mode is off, where she could turn it on. */
export const CODE_NUDGE = "Code mode is off. If this is coding, turn it on now with threads code (task and done), so the next turn runs on the coding model.";
export const CODE_TOOLS_OFF = ["models", "download_model", "model_files", "image", "react"];
export function codeTaskText(task: { task: string; done: string } | undefined): string {
  return task?.task.trim() ? `Code task\n${task.task}\n\nDone so far\n${task.done}` : "Code task\nSet the task and progress first with threads({ action: \"code\", on: true, task, done }).";
}
