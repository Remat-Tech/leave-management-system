import type { BalanceLine, TeamBooking, TeamMember } from '../../api';
import { days, inDays } from '../../format';
import { Icon, iconForLeaveType } from '../../Icon';

/**
 * What a direct report has left and what they have booked. FR 55, FR 56, LMS 405, LMS 409.
 *
 * Takes a `TeamMember` and never a `Colleague`: only `/api/me/team` may name a leave type.
 */
export function Reports({ member }: { member: TeamMember }) {
  return (
    <>
      <Figures lines={member.balances} />

      <details className="breakdown">
        <summary>Balances in full</summary>

        <table className="figures-table">
          <thead>
            <tr>
              <th scope="col">Leave</th>
              <th scope="col">Entitled</th>
              <th scope="col">Carried</th>
              <th scope="col">Adjusted</th>
              <th scope="col">Taken</th>
              <th scope="col">Pending</th>
              <th scope="col">Available</th>
            </tr>
          </thead>
          <tbody>
            {member.balances.map((line) => (
              <tr key={line.leaveTypeId}>
                <th scope="row">
                  {line.name}
                  <small>{line.allowanceInWords}</small>
                </th>
                <td>{days(line.entitled)}</td>
                <td>{days(line.carriedOver)}</td>
                <td>{days(line.adjustment)}</td>
                <td>{days(line.taken)}</td>
                <td>{days(line.pending)}</td>
                <td className={line.available < 0 ? 'overdrawn' : undefined}>
                  {days(line.available)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {member.booked.length === 0 ? null : (
        <ul className="away">
          {member.booked.map((booking) => (
            <Booking key={booking.requestId} booking={booking} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * What each kind of leave has left, as a figure each.
 *
 * Nothing is added up across the row: twenty annual days and three sick days are not
 * twenty-three of anything. A type that arrives with an occasion and has had none reads as a
 * dash rather than as nought, because a nought there means "not yet" and not "none left" —
 * the sentence in the table below says which.
 */
function Figures({ lines }: { lines: BalanceLine[] }) {
  return (
    <ul className="figures">
      {lines.map((line) => {
        const awaitingAnOccasion = line.entitlementBasis === 'EVENT' && !line.hasMoved;

        return (
          <li key={line.leaveTypeId}>
            <Icon name={iconForLeaveType(line.name)} />
            <span className="what">{line.name}</span>
            <span className={`figure${line.available < 0 ? ' overdrawn' : ''}`}>
              {awaitingAnOccasion ? '—' : days(line.available)}
            </span>
            <span className="of">{awaitingAnOccasion ? 'per occasion' : 'left'}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** One piece of live leave, in the server's own sentence. FR 56. */
function Booking({ booking }: { booking: TeamBooking }) {
  return (
    <li>
      <strong>
        {booking.from} to {booking.to}
      </strong>
      {` · ${inDays(booking.days)}`}
      {/* FR 24. Said only where the two differ, because "5 days, 5 days off" is noise. */}
      {booking.calendarDays === booking.days
        ? ''
        : ` charged, ${inDays(booking.calendarDays)} away`}
      {` · ${booking.typeName} · `}
      <span className={`tag status is-${booking.status.toLowerCase()}`}>
        {booking.agreed ? 'agreed' : 'waiting to be decided'}
      </span>
    </li>
  );
}
