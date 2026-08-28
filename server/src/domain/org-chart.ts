/**
 * The reporting structure, as a chart. FR 09. LMS 107.
 *
 * The story is an HR Officer looking at the organisation and seeing that
 * somebody's manager is wrong or missing — before a request is raised, routed at
 * that manager, and stuck. The list of employees does not show that. A tree does,
 * because a wrong line is visible as a person in the wrong place and a missing
 * one is visible as a branch hanging off nothing.
 *
 * ## Everybody appears exactly once
 *
 * That is the property this file is built around, and it is the one that makes
 * the chart worth looking at. A chart that quietly drops the people it could not
 * place is a chart that looks correct precisely when the organisation is not, and
 * the person it fails is the one whose manager is missing — which is to say
 * exactly the person the story is about.
 *
 * So there is one list of roots, every employee hangs off one of them, and a root
 * that should not be a root says why. See {@link RootStanding}. The head of the
 * organisation is a root because FR 04 says there is one; anything else at the
 * top of a line is a fault, named as such, with the whole branch below it still
 * drawn so that HR can see who is affected rather than only who is at fault.
 *
 * ## Five levels, and a great many more
 *
 * The fixture organisation is five deep and the story asks for five. Nothing here
 * counts levels or has a limit: the tree is built with an explicit stack rather
 * than by recursion, so depth costs memory and not stack frames, and a line ten
 * thousand deep is drawn rather than overflowing. That is not a hypothetical
 * being humoured — a loop in the data is an infinitely deep line, and the answer
 * to it must be a chart with a warning on it rather than a stack trace.
 *
 * ## What is not here
 *
 * No database. This is a pure function of the records it is handed, so the whole
 * of it can be tested without one — including the shapes that are hard to make in
 * a real database, like a loop, which the deferred cycle trigger of FR 03 refuses
 * on every connection.
 *
 * No pixels either. Two renderings are here because the system has no front end
 * yet and a chart nobody can look at is not a chart: {@link renderOrgChart} for
 * anywhere text goes, and {@link renderOrgChartAsMermaid} for anywhere a diagram
 * can be drawn. Both are pure functions of {@link OrgChart}, and so is the screen
 * that eventually replaces them — the tree is the deliverable and the drawings
 * are readings of it.
 */

import type { Employee } from './employee.js';

/**
 * One person and the people who report to them.
 *
 * `depth` is 1 at the top of a line, so the head of the organisation is at 1 and
 * the fixture organisation runs to 5. It is on the node rather than worked out by
 * whoever draws it, because every renderer wants it and each one working it out
 * again is each one able to get it wrong.
 */
export interface OrgChartNode {
  employee: Employee;
  depth: number;
  reports: OrgChartNode[];
}

/**
 * Why a line starts where it does.
 *
 * One of these is fine and the other two are the story: a branch at the top of
 * the chart that is not the head of the organisation is a branch whose requests
 * have nowhere to go.
 */
export const ROOT_STANDINGS = [
  /** FR 04. No line manager, because there is nobody above them. Exactly one. */
  'HEAD_OF_THE_ORGANISATION',
  /**
   * A second record with no line manager. FR 04 permits one.
   *
   * The `employee_one_root` index refuses this on every connection, so it takes a
   * database restored from before that index to produce one. Charted anyway,
   * because the chart should show what the table holds rather than what ought to
   * be possible.
   */
  'SECOND_HEAD',
  /**
   * Their manager is not among the records this chart was built from.
   *
   * `manager_id` is a foreign key, so the manager is somebody — this says they
   * are not *here*. It is what a chart of one department, or of everybody still
   * employed, is bound to produce, and it is the most useful line on the chart:
   * a team hanging off a manager who has left is the stuck request the story
   * exists to prevent, seen a fortnight early.
   */
  'MANAGER_NOT_ON_THE_CHART',
  /**
   * Their reporting line goes round in a circle. FR 03.
   *
   * Unreachable from any head, because walking down from a head never arrives.
   * The deferred cycle trigger refuses this on every connection and
   * `findManagerCycles()` refuses it in the staff import, so like a second head
   * it takes bad data from somewhere else. The chart draws it rather than
   * hanging, which is the whole reason the walk below carries a `seen` set.
   */
  'REPORTING_LINE_LOOPS',
] as const;

export type RootStanding = (typeof ROOT_STANDINGS)[number];

/** The top of one line, and whether it should be one. */
export interface OrgChartRoot {
  node: OrgChartNode;
  standing: RootStanding;
  /**
   * What is wrong, in words HR can act on. Null for the head of the
   * organisation, which is the one root that is not a fault.
   */
  concern: string | null;
}

export interface OrgChart {
  /**
   * Every line on the chart, the head of the organisation first and the faults
   * after it. Every employee given to {@link buildOrgChart} is somewhere under
   * exactly one of these.
   */
  roots: OrgChartRoot[];
  /** Levels in the deepest line. 5 for the fixture organisation, 0 for nobody. */
  depth: number;
  /** How many records the chart is drawn from. */
  total: number;
}

/**
 * The chart, from the manager relationships and from nothing else.
 *
 * Built downward from the tops of lines, which is the opposite direction to
 * {@link EmployeeRepository.chainFrom} and for the opposite reason: a request is
 * routed by walking up one line, and a chart is every line at once.
 *
 * The order is decided here rather than left to whatever order the rows arrived
 * in. Siblings run by surname, then forename, then employee number, so that two
 * people with the same name are still in a fixed order and the same organisation
 * always draws the same chart. A chart that reorders itself between two readings
 * is a chart nobody can compare with the one they printed yesterday.
 *
 * Three passes, none of them recursive:
 *
 *   Sort, and index the reports by their manager.
 *
 *   Walk down from every record with no manager, and from every record whose
 *   manager is not here. Both are tops of lines; only the first sort is allowed.
 *
 *   Whatever is still unvisited is in a loop, or hanging below one. Each
 *   remaining record in turn becomes the top of what is left of its own line,
 *   until nobody is unplaced.
 *
 * The `seen` set is what makes the third pass terminate, and it is load bearing
 * in the second one too: a loop reached from below would otherwise be walked for
 * ever.
 */
export function buildOrgChart(employees: readonly Employee[]): OrgChart {
  const ordered = [...employees].sort(byName);
  const byId = new Map(ordered.map((employee) => [employee.id, employee]));

  const reportsTo = new Map<string, Employee[]>();
  for (const employee of ordered) {
    if (employee.managerId !== null) {
      const siblings = reportsTo.get(employee.managerId);
      if (siblings === undefined) {
        reportsTo.set(employee.managerId, [employee]);
      } else {
        siblings.push(employee);
      }
    }
  }

  const seen = new Set<string>();
  const roots: OrgChartRoot[] = [];
  let deepest = 0;

  const take = (top: Employee, standing: RootStanding) => {
    const node = subtree(top, reportsTo, seen);

    deepest = Math.max(deepest, deepestIn(node));
    roots.push({ node, standing, concern: concernAbout(top, standing) });
  };

  /* The heads first, so that the first root is the head of the organisation on
     any chart that has one and the faults are what follows it. */
  let headTaken = false;
  for (const employee of ordered) {
    if (employee.managerId === null) {
      take(employee, headTaken ? 'SECOND_HEAD' : 'HEAD_OF_THE_ORGANISATION');
      headTaken = true;
    }
  }

  for (const employee of ordered) {
    if (!seen.has(employee.id) && employee.managerId !== null && !byId.has(employee.managerId)) {
      take(employee, 'MANAGER_NOT_ON_THE_CHART');
    }
  }

  /* Anybody left is unreachable from any top of any line, and over a finite set
     of records that each name a manager who is here, unreachable means looped.

     The line is rooted at somebody actually *in* the loop rather than at the
     first unplaced record by name, which is not a nicety. Those are often
     different people: somebody reporting into a loop is stuck by it without being
     part of it, and rooting the branch at them would draw the loop hanging
     underneath the person it has trapped, with the fault named against the wrong
     record. */
  for (const employee of ordered) {
    if (!seen.has(employee.id)) {
      take(inTheLoopAbove(employee, byId), 'REPORTING_LINE_LOOPS');
    }
  }

  return { roots, depth: deepest, total: ordered.length };
}

/** Everybody on the chart, top to bottom, left to right. */
export function everybodyOn(chart: OrgChart): Employee[] {
  return chart.roots.flatMap((root) => nodesUnder(root.node).map((node) => node.employee));
}

/** The roots that are faults, which is every root but the head. */
export function concerns(chart: OrgChart): OrgChartRoot[] {
  return chart.roots.filter((root) => root.concern !== null);
}

/**
 * The chart as text.
 *
 * Not a placeholder for a screen and not only a debugging aid. It goes in a
 * support request, in a nightly job's output and in an email to the HR officer
 * who asked why a request has not arrived, and in each of those a screen is no
 * use. The tree is what a front end will draw; this is what everything that is
 * not a front end can show.
 *
 * The connecting lines are the point rather than decoration. Five levels of plain
 * indentation is ten spaces and nobody can see which of three people at the same
 * indent belong to which manager, which is precisely the reading the story asks
 * for. `ascii` is there for anywhere those characters do not survive the journey.
 *
 * A concern is printed above the branch it is about, so that the fault and the
 * people it affects are read together.
 */
export function renderOrgChart(chart: OrgChart, options: { ascii?: boolean } = {}): string {
  const glyphs: Glyphs = options.ascii === true ? ASCII : LINES;
  const lines: string[] = [];

  for (const root of chart.roots) {
    if (lines.length > 0) {
      lines.push('');
    }
    if (root.concern !== null) {
      lines.push(`! ${root.concern}`);
    }

    lines.push(describe(root.node.employee));
    drawReports(root.node, '', lines, glyphs);
  }

  if (lines.length === 0) {
    lines.push('Nobody is on this chart.');
  }

  return lines.join('\n');
}

/**
 * The chart as a Mermaid flowchart, which is a chart somebody can actually look
 * at today.
 *
 * Mermaid rather than SVG, and text rather than an image, for the reason the
 * staff import reads a CSV rather than a workbook: it is drawn by things this
 * project already goes through — a pull request, the documents in `/docs`, most
 * markdown viewers — and it brings no dependency and nothing to keep patched.
 * When the front end arrives it will draw {@link OrgChart} directly and this
 * stays useful anyway, because a diagram that can be pasted into an issue is a
 * different job from a screen.
 *
 * Identifiers are `e` and the record's id, never the name: a Mermaid node id
 * cannot hold a space and a name is not unique. Labels are quoted and the one
 * character that would end a label early is escaped.
 */
export function renderOrgChartAsMermaid(chart: OrgChart): string {
  const lines = ['flowchart TD'];

  for (const root of chart.roots) {
    for (const node of nodesUnder(root.node)) {
      lines.push(`    ${nodeId(node.employee)}["${label(node.employee)}"]`);

      for (const report of node.reports) {
        lines.push(`    ${nodeId(node.employee)} --> ${nodeId(report.employee)}`);
      }
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ the walk */

/**
 * One line, drawn downward from its top.
 *
 * An explicit stack rather than recursion, so that the depth of the organisation
 * is a number rather than a limit. `seen` does two jobs: it stops a loop being
 * walked for ever, and it is how {@link buildOrgChart} knows afterwards who is
 * still unplaced.
 */
function subtree(
  top: Employee,
  reportsTo: ReadonlyMap<string, Employee[]>,
  seen: Set<string>,
): OrgChartNode {
  const root: OrgChartNode = { employee: top, depth: 1, reports: [] };
  seen.add(top.id);

  const pending: OrgChartNode[] = [root];

  while (pending.length > 0) {
    const node = pending.pop() as OrgChartNode;

    for (const report of reportsTo.get(node.employee.id) ?? []) {
      if (seen.has(report.id)) {
        continue;
      }

      seen.add(report.id);

      const child: OrgChartNode = { employee: report, depth: node.depth + 1, reports: [] };
      node.reports.push(child);
      pending.push(child);
    }
  }

  return root;
}

/**
 * Somebody in the loop that this person's reporting line runs into.
 *
 * The same walk `EmployeeService.checkManager()` and `findManagerCycles()` do,
 * and for the same reason those go upward: it is bounded by the depth of the
 * organisation rather than by its width, and the loop announces itself the moment
 * a name comes round twice.
 *
 * Only ever called with somebody the two passes above could not place, which
 * means every manager on the way up is here and unplaced too — so the walk cannot
 * run off the top, and remembering where it has been is what makes it stop.
 */
function inTheLoopAbove(start: Employee, byId: ReadonlyMap<string, Employee>): Employee {
  const walked = new Set<string>();
  let at = start;

  for (;;) {
    walked.add(at.id);

    const manager = at.managerId === null ? undefined : byId.get(at.managerId);

    /* Unreachable: a record with no manager, or one whose manager is not here, was
       taken as a root already. Answered rather than assumed, because the
       alternative is this loop never ending. */
    if (manager === undefined) {
      return at;
    }
    if (walked.has(manager.id)) {
      return manager;
    }

    at = manager;
  }
}

/** Every node of one line, the top first. Iterative, for the same reason. */
function nodesUnder(root: OrgChartNode): OrgChartNode[] {
  const found: OrgChartNode[] = [];
  const pending: OrgChartNode[] = [root];

  while (pending.length > 0) {
    const node = pending.pop() as OrgChartNode;

    found.push(node);
    // Reversed, so that popping restores the order the reports are held in.
    for (let index = node.reports.length - 1; index >= 0; index -= 1) {
      pending.push(node.reports[index]);
    }
  }

  return found;
}

function deepestIn(root: OrgChartNode): number {
  return nodesUnder(root).reduce((deepest, node) => Math.max(deepest, node.depth), 0);
}

/* ------------------------------------------------------------- what it says */

function concernAbout(employee: Employee, standing: RootStanding): string | null {
  const who = `${fullName(employee)} (${employee.employeeNumber})`;

  switch (standing) {
    case 'HEAD_OF_THE_ORGANISATION':
      return null;
    case 'SECOND_HEAD':
      return (
        `${who} is recorded with no line manager, and only the head of the ` +
        `organisation may be. Everybody drawn below them is in the same position: ` +
        `no request from any of them can be routed upward past ${fullName(employee)}. FR 04.`
      );
    case 'MANAGER_NOT_ON_THE_CHART':
      return (
        `${who} reports to somebody who is not on this chart. If this is the whole ` +
        `organisation, their manager has left or their record is wrong, and their ` +
        `requests have nowhere to go. FR 02.`
      );
    default:
      return (
        `${who} is in a reporting line that goes round in a circle, so walking up ` +
        `it never reaches anybody. Every request from this branch would go round ` +
        `it too. FR 03.`
      );
  }
}

interface Glyphs {
  branch: string;
  last: string;
  through: string;
  clear: string;
}

const LINES: Glyphs = { branch: '├── ', last: '└── ', through: '│   ', clear: '    ' };
const ASCII: Glyphs = { branch: '|-- ', last: '`-- ', through: '|   ', clear: '    ' };

interface Pending {
  node: OrgChartNode;
  /** What goes in front of this node's line, built from its ancestors. */
  prefix: string;
  /** Whether it is the last of its siblings, which decides the corner it gets. */
  isLast: boolean;
}

/**
 * Everybody below one root, one line each, in the order they are read.
 *
 * A stack rather than recursion, as {@link subtree} is and for the same reason:
 * the renderer must survive whatever the builder was willing to build, and a
 * looped line is arbitrarily deep. Reports are pushed backwards so that popping
 * takes them forwards, which is what keeps a branch under the person it belongs
 * to instead of beside them.
 */
function drawReports(root: OrgChartNode, prefix: string, lines: string[], glyphs: Glyphs): void {
  const pending: Pending[] = [];

  const queue = (node: OrgChartNode, at: string) => {
    for (let index = node.reports.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: node.reports[index],
        prefix: at,
        isLast: index === node.reports.length - 1,
      });
    }
  };

  queue(root, prefix);

  while (pending.length > 0) {
    const item = pending.pop() as Pending;
    const corner = item.isLast ? glyphs.last : glyphs.branch;

    lines.push(`${item.prefix}${corner}${describe(item.node.employee)}`);
    queue(item.node, `${item.prefix}${item.isLast ? glyphs.clear : glyphs.through}`);
  }
}

/**
 * One person on a line of the chart.
 *
 * The job title is here because a wrong line is usually spotted by the title
 * being in the wrong place rather than by the name being there, and a leaver is
 * marked because a manager who has left is the fault the story is named for. Both
 * are what makes a chart worth reading rather than a list with indentation.
 */
function describe(employee: Employee): string {
  const title = employee.jobTitle === null ? '' : ` — ${employee.jobTitle}`;
  const left =
    employee.employmentStatus === 'TERMINATED'
      ? `, left ${employee.exitDate ?? 'on a date that was not recorded'}`
      : '';

  return `${fullName(employee)}${title} (${employee.employeeNumber}${left})`;
}

function label(employee: Employee): string {
  const title = employee.jobTitle === null ? '' : `<br/>${employee.jobTitle}`;

  return escape(`${fullName(employee)}${title}`);
}

/** The one character that would end a Mermaid label early. */
function escape(text: string): string {
  return text.replaceAll('"', '#quot;');
}

function nodeId(employee: Employee): string {
  return `e${employee.id}`;
}

function fullName(employee: Employee): string {
  return `${employee.firstName} ${employee.lastName}`;
}

/**
 * Surname, then forename, then employee number.
 *
 * The number is not a tiebreak nobody will reach: two people called Kofi Mensah
 * is an ordinary thing in a company of this size, and without it their two
 * branches would swap places between readings.
 */
function byName(left: Employee, right: Employee): number {
  return (
    left.lastName.localeCompare(right.lastName) ||
    left.firstName.localeCompare(right.firstName) ||
    left.employeeNumber.localeCompare(right.employeeNumber)
  );
}
