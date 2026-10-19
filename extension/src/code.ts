/** Principle 8: five lines shared by code-mode turns and the coder role. */
export const CODE_GUIDELINES = `Read the repository instructions and relevant files before editing.
Run the repository’s checks after each change; start servers in the background with a time limit.
Read a failing log before changing anything.
Keep diffs small and focused on the task.
Say what you verified and what remains unchecked: a check that failed or never ran isn't done.`;
export const CODING_GUIDELINE = "For a coding job, delegate to the coder role for one change, start a thread with code: true for a larger build, or turn on code mode if the user is working with you on it.";
export const CODE_TOOLS_OFF = ["models", "download_model", "model_files", "image", "react"];
export function codeTaskText(task: { task: string; done: string } | undefined): string {
  return task?.task.trim() ? `Code task\n${task.task}\n\nDone so far\n${task.done}` : "Code task\nSet the task and progress first with threads({ action: \"code\", on: true, task, done }).";
}
