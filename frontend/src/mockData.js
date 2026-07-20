// Custom HR Software Mock Database Generator
// Generates 500+ employee records and other workflow databases for realistic operation.

const DEPARTMENTS = [
  'Engineering', 'Product Management', 'Sales', 'Marketing',
  'Human Resources', 'Finance', 'Customer Success', 'QA & Testing', 'IT & Operations'
];

const ROLES = {
  'Engineering': ['Software Engineer', 'Senior Engineer', 'Lead Engineer', 'Engineering Manager', 'Frontend Specialist', 'Backend Architect'],
  'Product Management': ['Product Manager', 'Associate PM', 'Director of Product', 'UX Researcher', 'Product Designer'],
  'Sales': ['Account Executive', 'Business Development Rep', 'Sales Manager', 'Enterprise Account Executive'],
  'Marketing': ['Content Specialist', 'SEO Manager', 'Marketing Director', 'Social Media Coordinator'],
  'Human Resources': ['HR Specialist', 'Talent Acquisition Partner', 'HR Business Partner', 'People Ops Coordinator'],
  'Finance': ['Financial Analyst', 'Senior Accountant', 'Finance Director', 'Payroll Analyst'],
  'Customer Success': ['CS Representative', 'Key Account Manager', 'CS Director', 'Technical Support Specialist'],
  'QA & Testing': ['QA Engineer', 'Automation Lead', 'SDET', 'QA Manager'],
  'IT & Operations': ['IT Support Specialist', 'DevOps Engineer', 'SysAdmin', 'Security Engineer']
};

const FIRST_NAMES = [
  'Amit', 'Priyanka', 'Rahul', 'Sneha', 'Vikram', 'Anjali', 'Rohan', 'Pooja', 'Siddharth', 'Aditi',
  'Karan', 'Neha', 'Arjun', 'Tanvi', 'Abhishek', 'Ritu', 'Manish', 'Shalini', 'Varun', 'Divya',
  'James', 'Sarah', 'Michael', 'Emily', 'David', 'Jessica', 'John', 'Amanda', 'Robert', 'Ashley',
  'Rajesh', 'Suresh', 'Ketan', 'Nisha', 'Vijay', 'Jyoti', 'Sunil', 'Preeti', 'Deepak', 'Kiran'
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Patel', 'Nair', 'Mehta', 'Singh', 'Joshi', 'Rao', 'Iyer',
  'Kumar', 'Reddy', 'Deshmukh', 'Choudhury', 'Sen', 'Das', 'Roy', 'Pillai', 'Bose', 'Mishra',
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Anderson', 'Taylor',
  'Saxena', 'Trivedi', 'Bahl', 'Malhotra', 'Bhasin', 'Kapoor', 'Khanna', 'Chatterjee', 'Mukherjee', 'Dutta'
];

const MANAGERS = [
  'Vikram Sharma', 'Anjali Mehta', 'Siddharth Nair', 'Nisha Reddy', 'David Smith', 'Rajesh Joshi'
];

const STATUSES = ['Active', 'Active', 'Active', 'Active', 'On Leave', 'Probation', 'Active', 'Active']; // Weighted towards Active

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomRange(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Generate 520 employees to exceed the 500-user capability requirement
export function generateEmployees() {
  const list = [];
  
  // Predefined users for testing & login demonstration
  const baseUsers = [
    {
      id: 'EMP001',
      name: 'Aditya Parakkat',
      role: 'Principal HR Specialist',
      department: 'Human Resources',
      email: 'aditya.p@hrflow.io',
      phone: '+91 98765 43210',
      joinDate: '2022-03-15',
      status: 'Active',
      avatar: 'AP',
      manager: 'Executive Committee',
      salary: {
        ctc: 2400000,
        base: 100000,
        hra: 40000,
        lta: 15000,
        special: 30000,
        pf: 12000,
        tds: 18000
      },
      performance: {
        rating: 4.8,
        potential: 'High',
        performance_9box: 'High',
        goals: [
          { text: 'Scale the engineering workforce by 40%', progress: 85 },
          { text: 'Reduce HR ticket resolution SLA to under 4 hours', progress: 95 },
          { text: 'Implement AI HR query automation (NAVOS)', progress: 100 }
        ]
      },
      assets: ['MacBook Pro 16"', '4K Dell Monitor', 'Apple Magic Keyboard', 'YubiKey 5C', 'Employee ID Badge'],
      documents: ['PAN Card', 'Aadhaar Card', 'Passport', 'Degree Certificate', 'Relieving Letter'],
      leaves: { sick: 8, casual: 10, earned: 18, lop: 0 }
    },
    {
      id: 'EMP002',
      name: 'Sneha Rao',
      role: 'Senior Software Engineer',
      department: 'Engineering',
      email: 'sneha.rao@hrflow.io',
      phone: '+91 91234 56789',
      joinDate: '2023-05-10',
      status: 'Active',
      avatar: 'SR',
      manager: 'Vikram Sharma',
      salary: {
        ctc: 1800000,
        base: 75000,
        hra: 30000,
        lta: 10000,
        special: 25000,
        pf: 9000,
        tds: 11000
      },
      performance: {
        rating: 4.5,
        potential: 'High',
        performance_9box: 'Medium',
        goals: [
          { text: 'Migrate legacy styling to Tailwind CSS v4', progress: 100 },
          { text: 'Improve bundle loading speed by 30%', progress: 60 },
          { text: 'Mentor 2 junior frontend engineers', progress: 90 }
        ]
      },
      assets: ['MacBook Pro 14"', 'Dell UltraSharp 27"', 'Logitech MX Master 3', 'Employee ID Badge'],
      documents: ['PAN Card', 'Aadhaar Card', 'Offer Letter', 'Form 16'],
      leaves: { sick: 5, casual: 7, earned: 12, lop: 0 }
    }
  ];

  list.push(...baseUsers);

  // Generate 518 remaining users
  for (let i = 3; i <= 520; i++) {
    const fName = getRandomElement(FIRST_NAMES);
    const lName = getRandomElement(LAST_NAMES);
    const name = `${fName} ${lName}`;
    const dept = getRandomElement(DEPARTMENTS);
    const role = getRandomElement(ROLES[dept]);
    const email = `${fName.toLowerCase()}.${lName.toLowerCase()}@hrflow.io`;
    const phone = `+91 9${getRandomRange(10000000, 99999999)}`;
    const status = getRandomElement(STATUSES);
    const manager = getRandomElement(MANAGERS);
    
    const year = getRandomRange(2021, 2026);
    const month = String(getRandomRange(1, 12)).padStart(2, '0');
    const day = String(getRandomRange(1, 28)).padStart(2, '0');
    const joinDate = `${year}-${month}-${day}`;

    const ctc = getRandomRange(400, 3000) * 1000;
    const base = Math.floor(ctc * 0.5 / 12);
    const hra = Math.floor(ctc * 0.2 / 12);
    const lta = Math.floor(ctc * 0.08 / 12);
    const special = Math.floor(ctc * 0.22 / 12);
    const pf = Math.floor(base * 0.12);
    const tds = Math.floor(ctc * 0.10 / 12);

    const rating = parseFloat((getRandomRange(25, 50) / 10).toFixed(1));
    const potentials = ['Low', 'Medium', 'High'];
    const perfs = ['Low', 'Medium', 'High'];
    const potential = getRandomElement(potentials);
    const performance_9box = getRandomElement(perfs);

    const empId = `EMP${String(i).padStart(3, '0')}`;

    list.push({
      id: empId,
      name,
      role,
      department: dept,
      email,
      phone,
      joinDate,
      status,
      avatar: fName[0] + lName[0],
      manager,
      salary: {
        ctc,
        base,
        hra,
        lta,
        special,
        pf,
        tds
      },
      performance: {
        rating,
        potential,
        performance_9box,
        goals: [
          { text: 'Complete quarterly performance review cycles', progress: getRandomRange(40, 100) },
          { text: 'Optimize internal departmental execution pipeline', progress: getRandomRange(20, 150) }
        ]
      },
      assets: ['ThinkPad L14', 'Standard Mouse', 'Employee ID Badge'],
      documents: ['PAN Card', 'Aadhaar Card', 'Offer Letter'],
      leaves: {
        sick: getRandomRange(1, 12),
        casual: getRandomRange(1, 12),
        earned: getRandomRange(5, 24),
        lop: getRandomRange(0, 3)
      }
    });
  }

  return list;
}

// Initial Recruitment Job Requisitions
export const initialJobs = [
  { id: 'JOB01', title: 'Senior React Developer', department: 'Engineering', location: 'Remote / Bangalore', type: 'Full-time', status: 'Open', applicants: 18, date: '2026-07-01' },
  { id: 'JOB02', title: 'Product Manager (Core HR)', department: 'Product Management', location: 'Mumbai Office', type: 'Full-time', status: 'Open', applicants: 12, date: '2026-07-05' },
  { id: 'JOB03', title: 'HR Business Partner', department: 'Human Resources', location: 'Bangalore Office', type: 'Full-time', status: 'Open', applicants: 34, date: '2026-06-28' },
  { id: 'JOB04', title: 'DevOps Engineer (AWS/Kubernetes)', department: 'IT & Operations', location: 'Remote', type: 'Full-time', status: 'Open', applicants: 9, date: '2026-07-10' },
  { id: 'JOB05', title: 'QA Automation Engineer', department: 'QA & Testing', location: 'Chennai Office', type: 'Contract', status: 'Closed', applicants: 22, date: '2026-05-15' }
];

// Initial Candidate Recruitment pipeline representing all ATS statuses from featuresList
export const initialCandidates = [
  { id: 'CAN01', name: 'Arjun Sen', jobTitle: 'Senior React Developer', stage: 'Applied', email: 'arjun.sen@gmail.com', matchScore: 92, date: '2026-07-17' },
  { id: 'CAN02', name: 'Ritu Deshmukh', jobTitle: 'Senior React Developer', stage: 'Shortlisted', email: 'ritu.d@gmail.com', matchScore: 88, date: '2026-07-16' },
  { id: 'CAN03', name: 'Varun Saxena', jobTitle: 'Senior React Developer', stage: 'Interview', email: 'varuns@yahoo.com', matchScore: 95, date: '2026-07-15' },
  { id: 'CAN04', name: 'Tanvi Trivedi', jobTitle: 'Product Manager (Core HR)', stage: 'Offered', email: 'tanvi.trivedi@outlook.com', matchScore: 90, date: '2026-07-12' },
  { id: 'CAN05', name: 'Abhishek Das', jobTitle: 'HR Business Partner', stage: 'Hired', email: 'abhidas@gmail.com', matchScore: 94, date: '2026-07-10' },
  { id: 'CAN06', name: 'Shalini Kapoor', jobTitle: 'DevOps Engineer', stage: 'Rejected', email: 'shalini.k@gmail.com', matchScore: 52, date: '2026-07-14' }
];

// Leave Applications workflow representing all Leave types & statuses from featuresList
export const initialLeaves = [
  { id: 'LRQ01', empId: 'EMP002', name: 'Sneha Rao', type: 'Casual Leave', start: '2026-07-20', end: '2026-07-22', days: 3, reason: 'Family function at home', status: 'Pending' },
  { id: 'LRQ02', empId: 'EMP005', name: 'Vikram Singh', type: 'Sick Leave', start: '2026-07-18', end: '2026-07-18', days: 1, reason: 'High fever', status: 'Approved' },
  { id: 'LRQ03', empId: 'EMP012', name: 'Tanvi Bose', type: 'Earned Leave', start: '2026-08-05', end: '2026-08-12', days: 8, reason: 'Annual vacation trip', status: 'Pending' },
  { id: 'LRQ04', empId: 'EMP015', name: 'Nisha Bhasin', type: 'Maternity Leave', start: '2026-09-01', end: '2026-11-30', days: 90, reason: 'Maternity clearance request', status: 'Approved' },
  { id: 'LRQ05', empId: 'EMP018', name: 'Rohan Pillai', type: 'Paternity Leave', start: '2026-07-25', end: '2026-07-30', days: 5, reason: 'Paternity leaves', status: 'Rejected' },
  { id: 'LRQ06', empId: 'EMP022', name: 'Manish Verma', type: 'Comp Off', start: '2026-07-12', end: '2026-07-12', days: 1, reason: 'Worked on weekend scheduled deployment', status: 'Cancelled' }
];

// Expense Reimbursement claims representing all statuses from featuresList
export const initialExpenses = [
  { id: 'EXP501', empId: 'EMP002', name: 'Sneha Rao', category: 'Conveyance', amount: 1250, date: '2026-07-14', receipt: 'receipt_cab.png', status: 'Pending', description: 'Uber travel to client office' },
  { id: 'EXP502', empId: 'EMP001', name: 'Aditya Parakkat', category: 'Mobile & Internet', amount: 899, date: '2026-07-10', receipt: 'jio_bill.png', status: 'Approved', description: 'Monthly internet broadband usage' },
  { id: 'EXP503', empId: 'EMP009', name: 'Karan Malhotra', category: 'Travel Expenses', amount: 14500, date: '2026-07-08', receipt: 'flight_ticket.png', status: 'Rejected', description: 'Business round-trip flight' },
  { id: 'EXP504', empId: 'EMP010', name: 'Priya Verma', category: 'Software/Hardware', amount: 5600, date: '2026-07-12', receipt: 'aws_invoice.png', status: 'Paid', description: 'AWS sandbox usage charges' },
  { id: 'EXP505', empId: 'EMP014', name: 'Rahul Gupta', category: 'Office Supplies', amount: 450, date: '2026-07-17', receipt: 'receipt_pen.png', status: 'Draft', description: 'Purchase of notebook and whiteboard markers' }
];

// Helpdesk Tickets representing all statuses from featuresList
export const initialTickets = [
  { id: 'TCK101', name: 'Sneha Rao', empId: 'EMP002', category: 'Payroll Query', subject: 'Tax deduction discrepancy in June payslip', priority: 'Medium', status: 'Open', date: '2026-07-15' },
  { id: 'TCK102', name: 'Amit Sharma', empId: 'EMP003', category: 'IT Support', subject: 'MacBook charger not working', priority: 'High', status: 'In Progress', date: '2026-07-16' },
  { id: 'TCK103', name: 'Pooja Nair', empId: 'EMP008', category: 'HR Policy', subject: 'Maternity leave policy clarification needed', priority: 'Low', status: 'Resolved', date: '2026-07-10' },
  { id: 'TCK104', name: 'James Smith', empId: 'EMP015', category: 'Facility/Admin', subject: 'Workspace chair lock is damaged', priority: 'Low', status: 'On Hold', date: '2026-07-17' }
];

// Onboarding Candidates checklists representing pre-boarding statuses
export const initialOnboarding = [
  { id: 'ONB01', name: 'Neha Gupta', jobTitle: 'QA Engineer', joinDate: '2026-08-01', department: 'QA & Testing', progress: 40, tasks: [
    { id: 't1', title: 'Submit PAN & Aadhaar details', assignee: 'Candidate', status: 'Completed' },
    { id: 't2', title: 'Sign offer letter and NDA', assignee: 'Candidate', status: 'Completed' },
    { id: 't3', title: 'Configure MacBook Pro & corporate email', assignee: 'IT Team', status: 'Pending' },
    { id: 't4', title: 'Create Employee ID badge', assignee: 'Admin Team', status: 'Pending' },
    { id: 't5', title: 'Schedule team introductory meeting', assignee: 'Manager', status: 'Pending' }
  ]},
  { id: 'ONB02', name: 'Varun Pillai', jobTitle: 'Content Specialist', joinDate: '2026-08-03', department: 'Marketing', progress: 80, tasks: [
    { id: 't1', title: 'Submit PAN & Aadhaar details', assignee: 'Candidate', status: 'Completed' },
    { id: 't2', title: 'Sign offer letter and NDA', assignee: 'Candidate', status: 'Completed' },
    { id: 't3', title: 'Configure Laptop & corporate email', assignee: 'IT Team', status: 'Completed' },
    { id: 't4', title: 'Create Employee ID badge', assignee: 'Admin Team', status: 'Completed' },
    { id: 't5', title: 'Schedule team introductory meeting', assignee: 'Manager', status: 'Pending' }
  ]}
];

// Exit clearances representing all exit statuses from featuresList
export const initialExits = [
  { id: 'EXT01', empId: 'EMP045', name: 'Preeti Saxena', department: 'Marketing', lastDay: '2026-07-31', status: 'Clearance in Progress', approvals: { IT: 'Approved', Admin: 'Pending', Finance: 'Pending', HR: 'Pending' } },
  { id: 'EXT02', empId: 'EMP088', name: 'Suresh Trivedi', department: 'Engineering', lastDay: '2026-07-25', status: 'Cleared', approvals: { IT: 'Approved', Admin: 'Approved', Finance: 'Approved', HR: 'Approved' } },
  { id: 'EXT03', empId: 'EMP120', name: 'Preeti Sharma', department: 'Customer Success', lastDay: '2026-07-15', status: 'Notice Period Served', approvals: { IT: 'Approved', Admin: 'Approved', Finance: 'Approved', HR: 'Approved' } },
  { id: 'EXT04', empId: 'EMP145', name: 'Jyoti Rao', department: 'Sales', lastDay: '2026-06-30', status: 'Settled', approvals: { IT: 'Approved', Admin: 'Approved', Finance: 'Approved', HR: 'Approved' } },
  { id: 'EXT05', empId: 'EMP160', name: 'Vijay Pillai', department: 'Finance', lastDay: '2026-08-15', status: 'Retained', approvals: { IT: 'Pending', Admin: 'Pending', Finance: 'Pending', HR: 'Pending' } }
];

// Current attendance logs representing all attendance statuses from featuresList
export const initialAttendance = [
  { date: '2026-07-17', checkIn: '09:12 AM', checkOut: '06:15 PM', hours: '9.0h', status: 'On Time' },
  { date: '2026-07-16', checkIn: '09:05 AM', checkOut: '06:30 PM', hours: '9.4h', status: 'On Time' },
  { date: '2026-07-15', checkIn: '09:34 AM', checkOut: '05:45 PM', hours: '8.2h', status: 'Late In' },
  { date: '2026-07-14', checkIn: '--:-- --', checkOut: '--:-- --', hours: '0.0h', status: 'Absent' },
  { date: '2026-07-13', checkIn: '09:02 AM', checkOut: '01:00 PM', hours: '4.0h', status: 'Half Day' },
  { date: '2026-07-10', checkIn: '09:00 AM', checkOut: '04:15 PM', hours: '7.2h', status: 'Early Out' },
  { date: '2026-07-09', checkIn: '09:00 AM', checkOut: '06:00 PM', hours: '9.0h', status: 'Regularized' }
];

export const holidayCalendar = [
  { date: '2026-08-15', name: 'Independence Day', day: 'Saturday' },
  { date: '2026-09-07', name: 'Ganesh Chaturthi', day: 'Monday' },
  { date: '2026-10-02', name: 'Gandhi Jayanti', day: 'Friday' },
  { date: '2026-10-22', name: 'Dussehra', day: 'Thursday' },
  { date: '2026-11-08', name: 'Diwali', day: 'Sunday' },
  { date: '2026-12-25', name: 'Christmas Day', day: 'Friday' }
];

export const companyPolicies = [
  { id: 'POL01', title: 'Employee Handbook v4.2', category: 'General', updateDate: '2026-01-10', signed: true },
  { id: 'POL02', title: 'IT Asset Acceptable Use Policy', category: 'IT Support', updateDate: '2026-03-05', signed: true },
  { id: 'POL03', title: 'Travel & Expense Reimbursement Policy', category: 'Finance', updateDate: '2025-11-20', signed: false },
  { id: 'POL04', title: 'Maternity/Paternity Leave Policies', category: 'HR Policy', updateDate: '2026-06-15', signed: true }
];

export const initialAssetInventory = [
  { id: 'AST001', type: 'Laptop', name: 'MacBook Pro 16"', serial: 'C02F289PQ05D', allocatedTo: 'Aditya Parakkat', status: 'Allocated' },
  { id: 'AST002', type: 'Monitor', name: 'Dell UltraSharp 27"', serial: 'CN-0N182F-74443', allocatedTo: 'Sneha Rao', status: 'Allocated' },
  { id: 'AST003', type: 'Laptop', name: 'ThinkPad L14', serial: 'PF-18XJQ8', allocatedTo: 'Karan Malhotra', status: 'Allocated' },
  { id: 'AST004', type: 'Laptop', name: 'MacBook Pro 14"', serial: 'C02D1828XAQ2', allocatedTo: 'Unallocated', status: 'Available' },
  { id: 'AST005', type: 'Accessories', name: 'YubiKey 5C NFC', serial: 'YK-8827361', allocatedTo: 'Aditya Parakkat', status: 'Allocated' },
  { id: 'AST006', type: 'Laptop', name: 'Dell Latitude 3520', serial: 'DL-8820X31', allocatedTo: 'Vikram Singh', status: 'Under Repair' },
  { id: 'AST007', type: 'Monitor', name: 'HP EliteDisplay E243', serial: 'HP-9988271', allocatedTo: 'Amit Sharma', status: 'Damaged' },
  { id: 'AST008', type: 'Mobile', name: 'iPhone 13 Pro', serial: 'AP-IPH13P22', allocatedTo: 'Preeti Saxena', status: 'Retired' }
];

export const initialIntegrations = [
  { id: 'int_gwork', name: 'Google Workspace', desc: 'Sync directories, Gmail, Google Calendar, and Meet', type: 'Collaboration', connected: true },
  { id: 'int_m365', name: 'Microsoft 365 / Outlook', desc: 'Sync directories, emails, calendar, and Teams', type: 'Collaboration', connected: false },
  { id: 'int_slack', name: 'Slack Notifications', desc: 'Auto-post payroll announcements, leaves, and approvals', type: 'Communication', connected: true },
  { id: 'int_whatsapp', name: 'WhatsApp Business API', desc: 'Send payslips and announcements to staff mobile', type: 'Communication', connected: false },
  { id: 'int_biometric', name: 'Biometric Access Controller', desc: 'Sync punch logs from fingerprint/facial terminals', type: 'Hardware', connected: true },
  { id: 'int_accounting', name: 'Zoho / QuickBooks', desc: 'Auto-sync monthly journal logs to accounting ledger', type: 'Finance', connected: false }
];

export const auditLogs = [
  { id: 'LOG501', user: 'Aditya Parakkat', action: 'Approved Leave (LRQ02) for Vikram Singh', ip: '192.168.1.42', time: '2026-07-18 11:15 AM' },
  { id: 'LOG502', user: 'System (NAVOS)', action: 'Generated Monthly PF Challan ECR File', ip: 'localhost', time: '2026-07-18 09:00 AM' },
  { id: 'LOG503', user: 'Aditya Parakkat', action: 'Assigned ThinkPad L14 to Karan Malhotra', ip: '192.168.1.42', time: '2026-07-17 04:30 PM' },
  { id: 'LOG504', user: 'Sneha Rao', action: 'Uploaded Tax Declaration Proof (80C)', ip: '192.168.1.15', time: '2026-07-16 02:14 PM' }
];
