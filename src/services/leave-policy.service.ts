import { prisma } from '../db/client';
import { ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

const DEFAULT_POLICY = `*Leave Policy*

*1. Casual Leave*

• Casual leave must be announced at least 3 days in advance
• In case of emergencies, prior notice may not be possible; however, the employee must inform their manager as soon as reasonably possible
• Leave for multiple employees from the same team requires additional approval
• Leave during periods of high workload may be restricted or require additional approval

*2. Sick Leave*

• Sick leave may be taken when an employee is unwell or medically unfit to work
• Employees should inform their manager as early as possible
• Medical proof may be requested for extended or repeated sick leave

*3. Leave Carry Forward & Cash-Out*

• Unused leave at the end of the year may be carried over to the next year
• Accumulated leave not utilized within the defined period will be cashed out to the employee as per company policy

*4. Half-Day Leave*

• Half-day leave may be taken with prior approval
• Counts as 0.5 day from the leave balance

*5. Work From Home (WFH) Policy*

• Employees must maintain a quiet, safe, and distraction-free workspace at their home
• Employees must regularly check company communication tools like Slack
• Working from public places such as cafés, restaurants, or co-working spaces is not permitted
• Employees must ensure reliable internet connectivity to perform their duties effectively
• Use of public Wi-Fi should be avoided due to security risks
• Shoulder surfing must be avoided at all times. Employees must ensure that confidential or sensitive information displayed on screens is not visible to family members, visitors, or any unauthorized individuals
• If an employee is unable to work effectively due to health, personal, or environmental reasons, they should apply for leave instead of work from home
• Failure to comply with the WFH policy may result in revocation of WFH privileges

*6. Leave Approval & Tracking*

• All leave must be approved by the reporting manager
• Leave must be recorded in the Slack app`;

export interface LeavePolicy {
  id: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get the leave policy content
 * Creates default policy if it doesn't exist
 */
export async function getLeavePolicy(): Promise<LeavePolicy> {
  let policy = await prisma.leavePolicy.findUnique({
    where: { id: 'default' },
  });

  if (!policy) {
    logger.info({ event: 'no_policy_found', action: 'creating_default' });
    policy = await prisma.leavePolicy.create({
      data: {
        id: 'default',
        content: DEFAULT_POLICY,
      },
    });
  }

  return policy;
}

/**
 * Update the leave policy content
 */
export async function updateLeavePolicy(content: string, updaterId: string): Promise<LeavePolicy> {
  if (!content || content.trim().length === 0) {
    throw new ValidationError('Policy content cannot be empty');
  }

  if (content.length > 3000) {
    throw new ValidationError('Policy content exceeds maximum length of 3000 characters');
  }

  const policy = await prisma.leavePolicy.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      content,
    },
    update: {
      content,
    },
  });

  logger.info({ event: 'policy_updated', updaterId });

  return policy;
}

/**
 * Reset the leave policy to default
 */
export async function resetLeavePolicy(): Promise<LeavePolicy> {
  const policy = await prisma.leavePolicy.update({
    where: { id: 'default' },
    data: {
      content: DEFAULT_POLICY,
    },
  });

  logger.info({ event: 'policy_reset' });

  return policy;
}
