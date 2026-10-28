// Makes the record of a run of a procedure, and says whether one is complete (docs/plan/slice-27.md, S27-7).
// The build-phases page: "the record of each run is kept in the `ekdotico` repository, with its date and the
// version of the release tested".
//
//   node scripts/record.ts new <procedure> <release>     docs/records/runs/<procedure>/<date>-<release>.md
//   node scripts/record.ts check <record>                exits 1 while a box is not ticked or a field is not filled
//   node scripts/record.ts list                          the procedures
//
// `new` copies the steps of the procedure into the record, so the record shows what was asked even if the
// procedure changes later, and refuses to replace a record that is there. A record holds no secret.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const PROCEDURES: Record<string, string> = {
  'editor-performance': 'docs/procedures/01-editor-performance.md',
  'health-checks': 'docs/procedures/02-health-checks.md',
  'connection-limit': 'docs/procedures/03-connection-limit.md',
  accessibility: 'docs/procedures/04-accessibility.md',
  browsers: 'docs/procedures/05-browsers.md',
  'backup-and-restore': 'docs/procedures/06-backup-and-restore.md',
  'secret-rotation': 'docs/operations/secret-rotation.md',
};

export const RUNS = 'docs/records/runs';
/** A field to fill: four underscores or more. */
export const BLANK = /_{4,}/;
export const UNTICKED = /^\s*- \[ \]/m;

export function newRecord(procedure: string, release: string, today = new Date(), runs = RUNS): string {
  const source = PROCEDURES[procedure];
  if (!source)
    throw new Error(
      `No procedure "${procedure}". The procedures are: ${Object.keys(PROCEDURES).join(', ')}.`,
    );
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(release))
    throw new Error('The release is a version, such as 0.1.0.');
  const date = today.toISOString().slice(0, 10);
  const target = join(runs, procedure, `${date}-${release}.md`);
  if (existsSync(target)) throw new Error(`${target} is there already: a record is never replaced.`);
  const text = readFileSync(source, 'utf8');
  const steps = text.slice(text.indexOf('\n## ') + 1);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `# Record: ${procedure}, release ${release}, ${date}\n\n` +
      `Procedure: \`${source}\`, as it was on ${date}. Run by: ____. Started: ____. Ended: ____.\n\n${steps}`,
    { flag: 'wx' },
  );
  return target;
}

/** What is left to do in a record: one line for each box and each field. */
export function whatIsLeft(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, at) =>
      /^\s*- \[ \]/.test(line) || BLANK.test(line) ? [`line ${at + 1}: ${line.trim().slice(0, 100)}`] : [],
    );
}

if (import.meta.main) {
  const [command, a, b] = process.argv.slice(2);
  try {
    if (command === 'new' && a && b) console.log(newRecord(a, b));
    else if (command === 'check' && a) {
      const left = whatIsLeft(readFileSync(a, 'utf8'));
      if (left.length > 0) {
        console.error(`${basename(a)}: not complete, ${left.length} left:\n${left.join('\n')}`);
        process.exit(1);
      }
      console.log(
        `${basename(a)}: complete. It is met only if the sentence "Met when" is true of what is written.`,
      );
    } else if (command === 'list') console.log(Object.keys(PROCEDURES).join('\n'));
    else throw new Error('Usage: record.ts new <procedure> <release> | check <record> | list');
  } catch (error) {
    console.error(`record: ${(error as Error).message}`);
    process.exit(2);
  }
}
