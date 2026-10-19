/** Principle 8: five lines shared by code-mode turns and the coder role. */
export const CODE_GUIDELINES = `Read the repository instructions and relevant files before editing.
Run the repository’s checks after each change; start servers in the background with a time limit.
Read a failing log before changing anything.
Keep diffs small and focused on the task.
Say what you verified and what remains unchecked: a check that failed or never ran isn't done.`;
export const CODING_GUIDELINE = "For a coding job outside a project chat, code in this thread: before your first edit, however small the change, turn on code mode (threads code, with task and done), and turn it off (on: false) when the coding is done. "
  + "Start a code: true thread only if the user asks for one. Delegate a small change on the side to the coder role. "
  + "Requested code children get their own worktrees and branches; keep the base and merge their branches here, starting a merge thread only if the user asks for one.";
/** Added once to the first edit or write while code mode is off, where she could turn it on. */
export const CODE_NUDGE = "Code mode is off. If this is coding, turn it on now with threads code (task and done), so the next turn runs on the coding model.";
export const CODE_TOOLS_OFF = ["models", "download_model", "model_files", "image", "react"];
export function codeTaskText(task: { task: string; done: string } | undefined): string {
  return task?.task.trim() ? `Code task\n${task.task}\n\nDone so far\n${task.done}` : "Code task\nSet the task and progress first with threads({ action: \"code\", on: true, task, done }).";
}
