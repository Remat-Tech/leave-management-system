import { Icon, type IconName } from '../../Icon';

/**
 * The HR screens behind one tab, as cards.
 *
 * The rail carried fifteen tabs, most of which refused most people. The screens are
 * unchanged and still reachable by their own addresses; this is the way in.
 *
 * **Which cards appear is the server's answer**, from `/api/me/sections`, which asks each
 * screen's own policy. Nothing here decides who may see what: an id this person was not
 * given is simply not drawn, and opening its address anyway still meets the refusal the
 * screen always gave.
 */

export type HrSectionId =
  | 'leave-types'
  | 'entitlements'
  | 'approval-chains'
  | 'holidays'
  | 'adjustments'
  | 'leave-events'
  | 'leavers'
  | 'policy'
  | 'email-wording'
  | 'reports'
  | 'audit';

export interface HrSection {
  id: HrSectionId;
  label: string;
  icon: IconName;
  description: string;
}

export const HR_GROUPS: { title: string; sections: HrSection[] }[] = [
  {
    title: 'Leave setup',
    sections: [
      {
        id: 'leave-types',
        label: 'Leave types',
        icon: 'settings',
        description: 'The kinds of leave, what each is called and how its days are counted.',
      },
      {
        id: 'entitlements',
        label: 'Entitlements',
        icon: 'balances',
        description: 'What each type is worth, from when, and for whom.',
      },
      {
        id: 'approval-chains',
        label: 'Approval chains',
        icon: 'stage',
        description: 'Who decides each kind of leave, and in what order.',
      },
      {
        id: 'holidays',
        label: 'Holidays',
        icon: 'holiday',
        description: 'The days the office is closed, which nobody is charged leave for.',
      },
    ],
  },
  {
    title: "People's figures",
    sections: [
      {
        id: 'adjustments',
        label: 'Adjustments',
        icon: 'pencil',
        description: 'Putting one balance right, with the reason kept beside it.',
      },
      {
        id: 'leave-events',
        label: 'Life events',
        icon: 'plus',
        description: 'A birth, a bereavement and the like, which grants that leave.',
      },
      {
        id: 'leavers',
        label: 'Leavers',
        icon: 'people',
        description: 'What somebody who has left is owed, as a breakdown.',
      },
    ],
  },
  {
    title: 'Company',
    sections: [
      {
        id: 'policy',
        label: 'Policy',
        icon: 'settings',
        description:
          'The Chief Executive, overturning a manager, and how long certificates are kept.',
      },
      {
        id: 'email-wording',
        label: 'Email wording',
        icon: 'send',
        description: 'The words the system’s emails go out in.',
      },
    ],
  },
  {
    title: 'Oversight',
    sections: [
      {
        id: 'reports',
        label: 'Reports',
        icon: 'report',
        description: 'Leave across the company: liability, what was taken, and what is overdue.',
      },
      {
        id: 'audit',
        label: 'Audit log',
        icon: 'history',
        description: 'Who changed what, and when.',
      },
    ],
  },
];

/** Whether the hub has anything in it for this person, and so whether the tab is drawn. */
export function hasHrSection(sections: string[]): boolean {
  const hr = new Set<string>(HR_GROUPS.flatMap((group) => group.sections.map((one) => one.id)));

  return sections.some((id) => hr.has(id));
}

export function HrSettingsPage({ sections }: { sections: string[] }) {
  const mayReach = new Set(sections);

  const groups = HR_GROUPS.map((group) => ({
    title: group.title,
    sections: group.sections.filter((section) => mayReach.has(section.id)),
  })).filter((group) => group.sections.length > 0);

  if (groups.length === 0) {
    return (
      <div className="page">
        {/* `plain`, because nothing is wrong: these screens are simply not this person's. */}
        <p className="notice plain">
          There is nothing here for you. These screens set up leave for the whole company, so they
          belong to HR. Your own leave is on the other tabs.
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      {groups.map((group) => (
        <section key={group.title} className="section-group">
          <h2>{group.title}</h2>

          <ul className="cards">
            {group.sections.map((section) => (
              <li key={section.id} className="card section-card">
                <a href={`#/${section.id}`}>
                  <span className="card-head">
                    <span className="chip" aria-hidden="true">
                      <Icon name={section.icon} />
                    </span>
                    <h3>{section.label}</h3>
                  </span>
                  <p>{section.description}</p>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
