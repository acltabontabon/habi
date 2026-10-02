/** Text the instructions use to point at a package's own files. */

/** A Markdown link to a package file, relative to SKILL.md. */
export function fileLink(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return `[${name}](${path})`;
}

/** A documentation block for a script, to fill in. */
export function scriptDoc(path: string): string {
  return `\n\n### \`${path}\`\n\n- **Purpose:** \n- **Run:** \`${path}\`\n- **Inputs:** \n- **Outputs:** \n- **Requires:** \n`;
}
