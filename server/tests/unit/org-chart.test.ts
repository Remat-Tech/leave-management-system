import { describe, expect, it } from 'vitest';
import type { Employee } from '../../src/domain/employee.js';
import {
  buildOrgChart,
  concerns,
  everybodyOn,
  renderOrgChart,
  renderOrgChartAsMermaid,
  type OrgChart,
} from '../../src/domain/org-chart.js';

/**
 * The reporting structure, as a chart. FR 09. LMS 107.
 *
 * The whole of the shaping is a pure function, so this is where the story is
 * actually proved. ../integration/employee.test.ts shows that the service asks
 * the policy and that the fixture organisation charts to five levels; everything
 * that needs an organisation no database would accept is here, and there is a lot
 * of it — a loop, two heads, a manager who is not in the set, and a line fifty
 * thousand deep are all shapes the constraints of FR 03 and FR 04 exist to make
 * impossible, and all shapes the chart has to survive being handed.
 *
 * The property every test below is really about: **everybody appears exactly
 * once.** A chart that drops the people it could not place looks correct
 * precisely when the organisation is not, and the person it drops is the one
 * whose manager is missing — which is the person the story is about.
 */

/** A record, with the fields the chart reads filled in honestly. */
function person(
  id: string,
  name: string,
  managerId: string | null,
  overrides: Partial<Employee> = {},
): Employee {
  const [firstName, ...rest] = name.split(' ');

  return {
    id,
    employeeNumber: `RH-${id.padStart(4, '0')}`,
    firstName,
    lastName: rest.join(' '),
    workEmail: `${firstName.toLowerCase()}@rematholdings.com`,
    jobTitle: null,
    departmentId: 'operations',
    managerId,
    workPatternId: 'standard',
    startDate: '2026-01-05',
    exitDate: null,
    employmentType: 'FULL_TIME',
    employmentStatus: 'ACTIVE',
    gender: null,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
    ...overrides,
  };
}

/** The fixture organisation's shape: five levels, and managers who are also reports. */
function fiveLevels(): Employee[] {
  return [
    person('1', 'Kwame Asante', null, { jobTitle: 'Chief Executive' }),
    person('2', 'Nana Owusu', '1', { jobTitle: 'Operations Director' }),
    person('3', 'Akosua Darko', '2', { jobTitle: 'Operations Manager' }),
    person('4', 'Kofi Boateng', '3', { jobTitle: 'Team Lead' }),
    person('5', 'Adwoa Frimpong', '4', { jobTitle: 'Operations Officer' }),
    person('6', 'Abena Sarpong', '4', { jobTitle: 'Analyst' }),
  ];
}

/** Everybody on the chart, by id, so it can be compared with what went in. */
function idsOn(chart: OrgChart): string[] {
  return everybodyOn(chart)
    .map((employee) => employee.id)
    .sort();
}

describe('the chart', () => {
  it('is drawn from the manager relationships and from nothing else', () => {
    const chart = buildOrgChart(fiveLevels());

    expect(chart.roots).toHaveLength(1);
    expect(chart.roots[0].standing).toBe('HEAD_OF_THE_ORGANISATION');
    expect(chart.roots[0].concern).toBeNull();
    expect(chart.roots[0].node.employee.firstName).toBe('Kwame');

    const director = chart.roots[0].node.reports[0];
    expect(director.employee.firstName).toBe('Nana');
    expect(director.reports[0].employee.firstName).toBe('Akosua');
  });

  /* The story's second criterion, said as a number. */
  it('handles five levels', () => {
    const chart = buildOrgChart(fiveLevels());

    expect(chart.depth).toBe(5);
    expect(chart.total).toBe(6);
    expect(idsOn(chart)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('puts the depth on every node, counting the head as one', () => {
    const head = buildOrgChart(fiveLevels()).roots[0].node;

    expect(head.depth).toBe(1);
    expect(head.reports[0].depth).toBe(2);
    expect(head.reports[0].reports[0].reports[0].reports[0].depth).toBe(5);
  });

  it('charts an empty organisation as an empty chart rather than as a failure', () => {
    const chart = buildOrgChart([]);

    expect(chart.roots).toEqual([]);
    expect(chart.depth).toBe(0);
    expect(chart.total).toBe(0);
  });

  it('draws somebody who manages nobody', () => {
    const chart = buildOrgChart([person('1', 'Kwame Asante', null)]);

    expect(chart.depth).toBe(1);
    expect(chart.roots[0].node.reports).toEqual([]);
  });
});

describe('everybody appears exactly once', () => {
  it.each([
    ['an ordinary organisation', fiveLevels()],
    [
      'one with a manager who is not here',
      [person('4', 'Kofi Boateng', '3'), person('5', 'Adwoa Frimpong', '4')],
    ],
    [
      'one with two heads',
      [
        person('1', 'Kwame Asante', null),
        person('2', 'Ama Mensah', null),
        person('3', 'Efua Owusu', '2'),
      ],
    ],
    [
      'one with a loop',
      [
        person('1', 'Kwame Asante', null),
        person('2', 'Ama Mensah', '3'),
        person('3', 'Efua Owusu', '2'),
      ],
    ],
  ])('in %s', (_description, employees) => {
    const chart = buildOrgChart(employees);

    expect(idsOn(chart)).toEqual(employees.map((employee) => employee.id).sort());
    expect(chart.total).toBe(employees.length);
  });
});

describe('a manager who is not on the chart', () => {
  /* The most useful line on any chart, and the one the story is named for. This
     is what a chart of one department looks like, and what a chart of only the
     currently employed would look like the day a manager leaves. */
  it('is a branch of its own, with the whole team still drawn under it', () => {
    const chart = buildOrgChart([
      person('4', 'Kofi Boateng', '3'),
      person('5', 'Adwoa Frimpong', '4'),
      person('6', 'Abena Sarpong', '4'),
    ]);

    expect(chart.roots).toHaveLength(1);
    expect(chart.roots[0].standing).toBe('MANAGER_NOT_ON_THE_CHART');
    expect(chart.roots[0].node.reports).toHaveLength(2);
    expect(chart.roots[0].concern).toMatch(/not on this chart/);
    expect(chart.roots[0].concern).toContain('RH-0004');
  });

  it('does not quietly promote them to the head of the organisation', () => {
    const chart = buildOrgChart([person('4', 'Kofi Boateng', '3')]);

    expect(chart.roots[0].standing).not.toBe('HEAD_OF_THE_ORGANISATION');
    expect(concerns(chart)).toHaveLength(1);
  });
});

describe('a second head', () => {
  /* FR 04, and the employee_one_root index refuses it on every connection. The
     chart still draws it, because it should show what the table holds rather than
     what ought to be possible: a database restored from before that index can
     hold one, and this is what would say so. */
  it('is charted, and the first by name is the one treated as the head', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('2', 'Ama Mensah', null),
      person('3', 'Efua Owusu', '2'),
    ]);

    expect(chart.roots.map((root) => root.standing)).toEqual([
      'HEAD_OF_THE_ORGANISATION',
      'SECOND_HEAD',
    ]);
    expect(chart.roots[0].node.employee.id).toBe('1');
    expect(chart.roots[1].node.employee.id).toBe('2');
    expect(chart.roots[1].node.reports[0].employee.id).toBe('3');
    expect(chart.roots[1].concern).toMatch(/FR 04/);
  });
});

describe('a reporting line that loops', () => {
  /* The shape the deferred cycle trigger of FR 03 refuses on every connection,
     and the shape a chart must survive being handed anyway: unreachable from any
     head, and infinitely deep to anything that walks it without remembering where
     it has been. */
  it('is drawn rather than followed for ever', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('2', 'Ama Mensah', '3'),
      person('3', 'Efua Owusu', '2'),
    ]);

    const looped = chart.roots.filter((root) => root.standing === 'REPORTING_LINE_LOOPS');

    expect(looped).toHaveLength(1);
    expect(idsOn(chart)).toEqual(['1', '2', '3']);
    expect(looped[0].concern).toMatch(/round in a circle/);
  });

  it('draws a loop that nobody at all is above', () => {
    const chart = buildOrgChart([person('2', 'Ama Mensah', '3'), person('3', 'Efua Owusu', '2')]);

    expect(chart.roots).toHaveLength(1);
    expect(chart.roots[0].standing).toBe('REPORTING_LINE_LOOPS');
    expect(chart.depth).toBe(2);
  });

  it('draws the branch that hangs below a loop with it', () => {
    const chart = buildOrgChart([
      person('2', 'Ama Mensah', '3'),
      person('3', 'Efua Owusu', '2'),
      person('4', 'Adwoa Frimpong', '3'),
    ]);

    expect(chart.roots).toHaveLength(1);
    expect(idsOn(chart)).toEqual(['2', '3', '4']);
  });
});

describe('the order', () => {
  it('is by surname, then forename, then employee number', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('2', 'Zoe Boateng', '1'),
      person('3', 'Ama Darko', '1'),
      person('4', 'Abena Boateng', '1'),
    ]);

    expect(chart.roots[0].node.reports.map((node) => node.employee.id)).toEqual(['4', '2', '3']);
  });

  it('does not depend on the order the records arrived in', () => {
    const forwards = renderOrgChart(buildOrgChart(fiveLevels()));
    const backwards = renderOrgChart(buildOrgChart([...fiveLevels()].reverse()));

    expect(backwards).toBe(forwards);
  });

  it('separates two people with the same name by their number', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('9', 'Kofi Mensah', '1'),
      person('2', 'Kofi Mensah', '1'),
    ]);

    expect(chart.roots[0].node.reports.map((node) => node.employee.employeeNumber)).toEqual([
      'RH-0002',
      'RH-0009',
    ]);
  });
});

describe('however deep it goes', () => {
  /* "Without breaking" taken at more than its word. Five levels is what the story
     asks for and a limit is what it is really asking about, so there is not one.
     Fifty thousand is well past the depth at which a recursive walk runs out of
     stack, which is the whole reason the builder uses an explicit one — and it is
     not a hypothetical, because a loop in the data is an infinitely deep line
     until something bounds it. */
  const DEEP = 50_000;

  function aVeryLongLine(levels: number): Employee[] {
    return Array.from({ length: levels }, (_unused, index) =>
      person(String(index), `Deep Person${index}`, index === 0 ? null : String(index - 1)),
    );
  }

  it('is built without running out of stack', () => {
    const chart = buildOrgChart(aVeryLongLine(DEEP));

    expect(chart.depth).toBe(DEEP);
    expect(chart.total).toBe(DEEP);
    expect(chart.roots).toHaveLength(1);
  });

  /* Drawn at a smaller number than it is built at, and deliberately. Every level
     adds four characters to the front of every line below it, so the drawing of a
     line n deep is n² characters however it is produced. What the stack costs is
     nothing; what the output costs is the real limit, and no organisation has one
     of these anyway. */
  it('is drawn one line per person, however far it descends', () => {
    const drawn = renderOrgChart(buildOrgChart(aVeryLongLine(2_000)));

    expect(drawn.split('\n')).toHaveLength(2_000);
  });
});

describe('the text rendering', () => {
  it('draws the lines that make five levels readable', () => {
    expect(renderOrgChart(buildOrgChart(fiveLevels()))).toBe(
      [
        'Kwame Asante — Chief Executive (RH-0001)',
        '└── Nana Owusu — Operations Director (RH-0002)',
        '    └── Akosua Darko — Operations Manager (RH-0003)',
        '        └── Kofi Boateng — Team Lead (RH-0004)',
        '            ├── Adwoa Frimpong — Operations Officer (RH-0005)',
        '            └── Abena Sarpong — Analyst (RH-0006)',
      ].join('\n'),
    );
  });

  it('keeps a branch under the person it belongs to, not beside them', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('2', 'Ama Darko', '1'),
      person('3', 'Efua Owusu', '2'),
      person('4', 'Yaw Mensah', '1'),
    ]);

    expect(renderOrgChart(chart)).toBe(
      [
        'Kwame Asante (RH-0001)',
        '├── Ama Darko (RH-0002)',
        '│   └── Efua Owusu (RH-0003)',
        '└── Yaw Mensah (RH-0004)',
      ].join('\n'),
    );
  });

  it('marks a leaver, because a manager who has left is the fault to spot', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('2', 'Kojo Antwi', '1', {
        employmentStatus: 'TERMINATED',
        exitDate: '2026-07-15',
      }),
    ]);

    expect(renderOrgChart(chart)).toContain('Kojo Antwi (RH-0002, left 2026-07-15)');
  });

  it('prints the concern above the branch it is about', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('4', 'Kofi Boateng', '3'),
    ]);
    const lines = renderOrgChart(chart).split('\n');

    expect(lines[0]).toBe('Kwame Asante (RH-0001)');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/^! /);
    expect(lines[3]).toContain('Kofi Boateng');
  });

  it('says so when there is nobody', () => {
    expect(renderOrgChart(buildOrgChart([]))).toBe('Nobody is on this chart.');
  });

  it('can be drawn without the box characters', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null),
      person('2', 'Ama Darko', '1'),
      person('3', 'Yaw Mensah', '1'),
    ]);

    expect(renderOrgChart(chart, { ascii: true })).toBe(
      ['Kwame Asante (RH-0001)', '|-- Ama Darko (RH-0002)', '`-- Yaw Mensah (RH-0003)'].join('\n'),
    );
  });
});

describe('the Mermaid rendering', () => {
  it('is a flowchart of the same relationships', () => {
    const chart = buildOrgChart([
      person('1', 'Kwame Asante', null, { jobTitle: 'Chief Executive' }),
      person('2', 'Ama Darko', '1', { jobTitle: 'Head of HR' }),
    ]);

    expect(renderOrgChartAsMermaid(chart)).toBe(
      [
        'flowchart TD',
        '    e1["Kwame Asante<br/>Chief Executive"]',
        '    e1 --> e2',
        '    e2["Ama Darko<br/>Head of HR"]',
      ].join('\n'),
    );
  });

  it('escapes a name that would end a label early', () => {
    const chart = buildOrgChart([person('1', 'A"quoted" Name', null)]);
    const drawn = renderOrgChartAsMermaid(chart);

    expect(drawn).toContain('#quot;');
    expect(drawn).toBe('flowchart TD\n    e1["A#quot;quoted#quot; Name"]');
  });

  it('has an edge for every reporting line and no more', () => {
    const edges = renderOrgChartAsMermaid(buildOrgChart(fiveLevels()))
      .split('\n')
      .filter((line) => line.includes('-->'));

    expect(edges).toHaveLength(5);
  });
});
