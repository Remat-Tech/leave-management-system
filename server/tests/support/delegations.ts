/** The delegation service the leave doors take, built the one way. FR 49, LMS 327. */

import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/index.js';
import type { Guard } from '../../src/auth/policy.js';
import { ApprovalDelegationRepository } from '../../src/features/leave-request/delegation.db.js';
import { ApprovalDelegationService } from '../../src/features/leave-request/delegation.service.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';

export function delegationService(db: Kysely<Database>, guard: Guard): ApprovalDelegationService {
  return new ApprovalDelegationService(
    new ApprovalDelegationRepository(db),
    guard,
    new EmployeeRepository(db),
    new RoleRepository(db),
  );
}
