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
    //  emoji: '🏖️',
    //  color: '#36C5F0',
    //  defaultAllowance: 20,
    //  requiresApproval: true,
    //  affectsBalance: true,
    //  order: 1,
    //},
    {
      name: 'Sick Leave',
      emoji: '🤒',
      color: '#E01E5A',
      defaultAllowance: 10,
      requiresApproval: true,
      affectsBalance: true,
      order: 2,
    },
    {
      name: 'Work From Home',
      emoji: '🏠',
      color: '#2EB67D',
      defaultAllowance: 10,
      requiresApproval: true,
      affectsBalance: true,
      order: 3,
    },
    {
      name: 'Casual',
      //emoji: '👤',
      emoji: '🏖️',
      color: '#ECB22E',
      defaultAllowance: 5,
      requiresApproval: true,
      affectsBalance: true,
      order: 4,
    },
    //{
    //  name: 'Unpaid Leave',
    //  emoji: '📋',
    //  color: '#868686',
    //  defaultAllowance: null,
    //  requiresApproval: true,
    //  affectsBalance: false,
    //  order: 5,
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

  // Create some sample public holidays (US 2025)
  const holidays = [
    { name: "New Year's Day", date: new Date('2025-01-01') },
    { name: 'Martin Luther King Jr. Day', date: new Date('2025-01-20') },
    { name: "Presidents' Day", date: new Date('2025-02-17') },
    { name: 'Memorial Day', date: new Date('2025-05-26') },
    { name: 'Independence Day', date: new Date('2025-07-04') },
    { name: 'Labor Day', date: new Date('2025-09-01') },
    { name: 'Columbus Day', date: new Date('2025-10-13') },
    { name: 'Veterans Day', date: new Date('2025-11-11') },
    { name: 'Thanksgiving Day', date: new Date('2025-11-27') },
    { name: 'Christmas Day', date: new Date('2025-12-25') },
  ];

  for (const holiday of holidays) {
    await prisma.publicHoliday.upsert({
      where: {
        name_date: {
          name: holiday.name,
          date: holiday.date,
        },
      },
      update: {},
      create: holiday,
    });
  }
  console.log('✓ Public holidays created');

  console.log('');
  console.log('🎉 Database seeded successfully!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Start the app with: npm run dev');
  console.log('   You can do this via Prisma Studio: npm run db:studio');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
