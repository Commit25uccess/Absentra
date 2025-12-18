import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create default settings
  await prisma.settings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      defaultAllowance: 20,
      requireApproval: true,
      allowNegativeBalance: false,
      timezone: 'UTC',
      digestEnabled: true,
      digestHour: 9,
      digestMinute: 0,
      digestWeekdaysOnly: true,
    },
  });
  console.log('✓ Default settings created');

  // Create default leave types
  const leaveTypes = [
    //{
    //  name: 'PTO',
    //  emoji: '👤',
    //  color: '#36C5F0',
    //  defaultAllowance: 20,
    //  requiresApproval: true,
    //  affectsBalance: true,
    //  order: 1,
    //  customReminderMessage: 'Hi {{userName}}! 👋 Friendly reminder that you have PTO coming up. Enjoy your time off!',
    //},
    {
      name: 'Sick Leave',
      emoji: '🤒',
      color: '#E01E5A',
      defaultAllowance: 10,
      requiresApproval: true,
      affectsBalance: true,
      order: 2,
      customReminderMessage: 'Hi {{userName}}! 👋 Wishing you a quick recovery! Your sick leave is coming up. Take care and get well soon! 💪',
    },
    {
      name: 'Work From Home',
      emoji: '🏠',
      color: '#2EB67D',
      defaultAllowance: 10,
      requiresApproval: true,
      affectsBalance: true,
      order: 3,
      customReminderMessage: 'Hi {{userName}}! 👋 Just a reminder that you have WFH days scheduled. Make sure your home office is ready! 🏠💻',
    },
    {
      name: 'Casual Leave',
      emoji: '🏖️',
      color: '#ECB22E',
      defaultAllowance: 5,
      requiresApproval: true,
      affectsBalance: true,
      order: 4,
      customReminderMessage: 'Hi {{userName}}! 👋 Get ready to relax! Your casual leave is coming up. Enjoy your time off! 🌴',
    },
    //{
    //  name: 'Unpaid Leave',
    //  emoji: '📋',
    //  color: '#868686',
    //  defaultAllowance: null,
    //  requiresApproval: true,
    //  affectsBalance: false,
    //  order: 5,
    //  customReminderMessage: 'Hi {{userName}}! 👋 Reminder about your upcoming unpaid leave days.',
    //},
  ];

  for (const lt of leaveTypes) {
    await prisma.leaveType.upsert({
      where: { name: lt.name },
      update: lt,
      create: lt,
    });
  }
  console.log('✓ Leave types created');

  // Create default leave policy
  const defaultLeavePolicy = `# Leave Policy

## Overview
This document outlines the leave policies and procedures for our team. Please review this carefully before submitting leave requests.

## Leave Types

### 🏖️ Casual Leave
- **Allowance**: 5 days per year
- **Purpose**: Personal time off, vacations, and personal matters
- **Approval**: Requires manager approval
- **Notice**: Please request at least 3 days in advance when possible

### 🤒 Sick Leave
- **Allowance**: 10 days per year
- **Purpose**: When you're ill or needing medical care
- **Approval**: Requires manager approval (can be retroactive)
- **Notice**: Notify your manager as soon as possible

### 🏠 Work From Home (WFH)
- **Allowance**: 10 days per year
- **Purpose**: Remote work days when needed
- **Approval**: Requires manager approval
- **Notice**: Please request at least 1 day in advance

## General Rules

1. **Balances**: Your leave balance is calculated on a calendar year basis (January 1 - December 31)
2. **Working Days**: Leave is calculated in working days (excluding weekends and public holidays)
3. **Half-Days**: You can request half-day leave (morning or afternoon)
4. **Overlap**: Leave requests cannot overlap with existing approved leave
5. **Approval**: Most leave types require manager approval before the leave starts

## Requesting Leave

1. Use the \`/pto\` Slack command
2. Select your leave type and dates
3. Add a reason (visible only to managers)
4. Submit for approval
5. You'll receive a notification when your request is approved or rejected

## Important Notes

- Leave balances reset on January 1st each year
- Unused leave does not carry over to the next year
- Managers can view all leave requests and team availability
- For urgent leave needs, contact your manager directly

## Questions?

If you have questions about leave policies, please contact:
- Your team manager
- HR department
- Workspace administrators

---

*Last updated: ${new Date().toISOString().split('T')[0]}*`;

  await prisma.leavePolicy.upsert({
    where: { id: 'default' },
    update: { content: defaultLeavePolicy },
    create: {
      id: 'default',
      content: defaultLeavePolicy,
    },
  });
  console.log('✓ Default leave policy created');

  // Create a sample team
  await prisma.team.upsert({
    where: { name: 'Engineering' },
    update: {},
    create: {
      name: 'Engineering',
      description: 'Engineering team',
    },
  });
  console.log('✓ Sample team created');

  console.log('');
  console.log('🎉 Database seeded successfully!');
  console.log('');
  console.log('✓ Default settings created');
  console.log('✓ Leave types created with reminder messages (Sick Leave: 10, WFH: 10, Casual: 5)');
  console.log('✓ Default leave policy created');
  console.log('✓ Sample team created');
  console.log('');
  console.log('Next steps:');
  console.log('1. Start the app with: npm run dev');
  console.log('2. Or use Prisma Studio: npm run db:studio');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
