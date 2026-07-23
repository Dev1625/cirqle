import { doc, getDoc, setDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../config/firebase';

export async function seedSampleData(user: any) {
  if (!user) return;

  // 1. Ensure user document exists
  const userRef = doc(db, `users/${user.uid}`);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) {
    await setDoc(userRef, {
      userId: user.uid,
      name: user.displayName || 'Test User',
      role: null,
      company: null,
      bio: null,
      resumeText: null,
      targetIndustries: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Sample Data Set — 15 contacts spanning every industry lane, with shared
  // schools / connectionSource references so the Network Graph renders both
  // inferred (dashed) and explicit relationship edges out of the box.
  const people: any[] = [
    { name: 'Sarah Chen', company: 'Sequoia Capital', role: 'Partner', industry: 'Venture Capital', tier: 'Warm', summary: 'Met at SaaStr Annual. Focuses on AI enterprise tooling.', location: 'San Francisco, CA', school: 'Stanford University', seniority: 'Partner', email: 'sarah.chen@sequoiacap.com', tags: ['AI/ML', 'Enterprise SaaS'] },
    { name: 'Marcus Johnson', company: 'McKinsey & Co', role: 'Engagement Manager', industry: 'Consulting', tier: 'Cold', summary: 'Reached out over LinkedIn regarding digital transformation practices.', location: 'Chicago, IL', school: 'Northwestern University', seniority: 'Associate / Manager', email: 'marcus.johnson@mckinsey.com', tags: ['Digital Transformation'] },
    { name: 'Elena Rodriguez', company: 'Goldman Sachs', role: 'Vice President', industry: 'Investment Banking', tier: 'Strong', summary: 'Former colleague from college. Grabbing coffee next month.', location: 'New York, NY', school: 'University of Pennsylvania', seniority: 'VP+', email: 'elena.rodriguez@gs.com', tags: ['M&A', 'College Friend'] },
    { name: 'David Smith', company: 'Stripe', role: 'Product Manager', industry: 'Technology', tier: 'Cold', summary: 'Trying to get a referral for the TPM role.', location: 'San Francisco, CA', school: 'University of Michigan', seniority: 'Mid-Level', email: 'dsmith@stripe.com', tags: ['Referral Target'] },
    { name: 'Jessica Miller', company: 'Bain & Company', role: 'Associate Partner', industry: 'Consulting', tier: 'Warm', summary: 'Introduced by Marcus. Helpful with case prep.', location: 'Boston, MA', school: 'Dartmouth College', seniority: 'VP+', email: 'jessica.miller@bain.com', tags: ['Case Prep', 'Mentor'], connectionSource: 'Marcus Johnson' },
    { name: 'Tom Davis', company: 'Blackstone', role: 'Principal', industry: 'Private Equity', tier: 'Cold', summary: 'Cold emailed about their recent tech acquisitions.', location: 'New York, NY', school: 'Columbia University', seniority: 'VP+', email: 'tom.davis@blackstone.com', tags: ['Tech Buyouts'], connectionSource: 'Alex Johnson' },
    { name: 'Emily Wilson', company: 'a16z', role: 'Deal Partner', industry: 'Venture Capital', tier: 'Warm', summary: 'Chatted briefly at Demo Day. Shares a Stanford network with Sarah.', location: 'Palo Alto, CA', school: 'Stanford University', seniority: 'VP+', email: 'emily.wilson@a16z.com', tags: ['Demo Day', 'AI/ML'] },
    { name: 'James Taylor', company: 'Morgan Stanley', role: 'Managing Director', industry: 'Investment Banking', tier: 'Dormant', summary: 'Haven\'t spoken since 2023. Need to re-engage.', location: 'New York, NY', school: 'University of Pennsylvania', seniority: 'VP+', email: 'james.taylor@morganstanley.com', tags: ['Needs Re-engagement'] },
    { name: 'Olivia Martinez', company: 'Google', role: 'Engineering Director', industry: 'Technology', tier: 'Strong', summary: 'Mentor. Meets every quarter.', location: 'Mountain View, CA', school: 'University of Michigan', seniority: 'VP+', email: 'omartinez@google.com', tags: ['Mentor', 'Quarterly Sync'] },
    { name: 'Alex Johnson', company: 'KKR', role: 'Associate', industry: 'Private Equity', tier: 'Warm', summary: 'Went to the same undergrad. Active in alumni group.', location: 'New York, NY', school: 'University of Michigan', seniority: 'Associate / Manager', email: 'alex.johnson@kkr.com', tags: ['Alumni Network'] },
    { name: 'Priya Nair', company: 'UnitedHealth Group', role: 'VP of Strategy', industry: 'Healthcare', tier: 'Warm', summary: 'Connected through a mutual healthcare investor. Sharp on payer strategy.', location: 'Boston, MA', school: 'Johns Hopkins University', seniority: 'VP+', email: 'priya.nair@uhg.com', tags: ['Payer Strategy'] },
    { name: 'Michael Chen', company: 'Citadel', role: 'Portfolio Manager', industry: 'Hedge Fund', tier: 'Cold', summary: 'Cold outreach after reading his macro thread on X.', location: 'Chicago, IL', school: 'University of Chicago', seniority: 'Mid-Level', email: 'mchen@citadel.com', tags: ['Macro', 'Cold Outreach'] },
    { name: 'Rachel Kim', company: 'Bridgewater Associates', role: 'Associate', industry: 'Hedge Fund', tier: 'Warm', summary: 'Met through Michael. Interested in swapping notes on systematic strategies.', location: 'Westport, CT', school: 'Yale University', seniority: 'Associate / Manager', email: 'rachel.kim@bwater.com', tags: ['Systematic Strategies'], connectionSource: 'Michael Chen' },
    { name: 'Daniel Osei', company: 'Mayo Clinic', role: 'Director of Innovation', industry: 'Healthcare', tier: 'Strong', summary: 'Longtime advisor on healthtech ideas. Always responsive.', location: 'Rochester, MN', school: 'Johns Hopkins University', seniority: 'VP+', email: 'daniel.osei@mayo.edu', tags: ['HealthTech', 'Advisor'] },
    { name: 'Sophia Turner', company: 'Meta', role: 'Senior Product Manager', industry: 'Technology', tier: 'Cold', summary: 'Referred by Olivia. Working on Reality Labs growth.', location: 'Menlo Park, CA', school: 'Carnegie Mellon University', seniority: 'Mid-Level', email: 'sturner@meta.com', tags: ['Referral', 'AR/VR'], connectionSource: 'Olivia Martinez' },
  ];

  const now = new Date();
  const contactRefs: Record<string, string> = {};

  for (const person of people) {
    // 2. Create Contact
    const contactRef = await addDoc(collection(db, `users/${user.uid}/contacts`), {
      userId: user.uid,
      name: person.name,
      company: person.company,
      role: person.role,
      industry: person.industry,
      relationshipTier: person.tier,
      summary: person.summary,
      tags: person.tags || [],
      location: person.location || null,
      email: person.email || null,
      linkedinUrl: null,
      subIndustry: null,
      lastContactedAt: null,
      seniority: person.seniority || null,
      school: person.school || null,
      connectionSource: person.connectionSource || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    contactRefs[person.name] = contactRef.id;

    // Leave a couple of contacts untouched so the Directory/Tracker "not
    // contacted yet" state has real examples instead of only synthetic ones.
    if (person.name === 'Daniel Osei' || person.name === 'Sophia Turner') {
      continue;
    }

    // 3. Create Outreaches (1-2 per person)
    const outreachRef = collection(db, `users/${user.uid}/outreaches`);

    // Outreach 1: Usually sent sometime in the past
    let status = 'Sent';
    let responseReceived = 'No';
    let meetingHeld = false;
    let aiSummary = `Sent initial cold approach outlining mutual connections.`;
    const pastDate = new Date(now.getTime() - Math.random() * 10 * 24 * 60 * 60 * 1000); // Up to 10 days ago

    if (person.tier === 'Strong' || person.tier === 'Warm') {
      status = 'Meeting Complete';
      responseReceived = 'Yes';
      meetingHeld = true;
      aiSummary = `Great catch up. Discussed market trends and their recent fund.`;
    } else if (person.tier === 'Dormant') {
      status = 'Re-engage';
      aiSummary = `Need to send a check-in note soon.`;
    } else if (Math.random() > 0.5) {
      status = 'Pending Follow-Up';
      aiSummary = `Waiting on response. Need to bump to the top of inbox.`;
    } else if (Math.random() > 0.7) {
      status = 'Awaiting Response';
      aiSummary = `Just sent note, waiting for reply.`;
    }

    await addDoc(outreachRef, {
      userId: user.uid,
      contactId: contactRef.id,
      type: 'LinkedIn',
      channel: 'LinkedIn',
      subject: null,
      status: status,
      nextFollowUpDate: null,
      responseReceived: responseReceived,
      dateOfResponse: null,
      meetingHeld: meetingHeld,
      meetingDate: null,
      nextAction: status === 'Pending Follow-Up' || status === 'Re-engage' ? 'Send follow-up message' : null,
      referralGenerated: false,
      applicationLinked: null,
      notes: null,
      aiSummary: aiSummary,
      sentAt: pastDate,
      updatedAt: serverTimestamp()
    });

    // Outreach 2: Sometimes there's a second more recent interaction
    if (Math.random() > 0.5 && status !== 'Dormant') {
      let status2 = 'Responded';
      let responseReceived2 = 'Yes';
      let aiSummary2 = `They replied and agreed to a quick call next week.`;
      let nextAct: string | null = 'Follow up with times';

      if (status === 'Meeting Complete') {
        status2 = 'Sent';
        responseReceived2 = 'No';
        aiSummary2 = `Sent thank you note after the call with the promised PDF.`;
        nextAct = null;
      }

      const recentDate = new Date(pastDate.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days later

      await addDoc(outreachRef, {
        userId: user.uid,
        contactId: contactRef.id,
        type: 'Email',
        channel: 'Email',
        subject: 'Follow Up',
        status: status2,
        nextFollowUpDate: null,
        responseReceived: responseReceived2,
        dateOfResponse: null,
        meetingHeld: false,
        meetingDate: null,
        nextAction: nextAct,
        referralGenerated: false,
        applicationLinked: null,
        notes: null,
        aiSummary: aiSummary2,
        sentAt: recentDate,
        updatedAt: serverTimestamp()
      });
    }
  }

  // 4. A drafted-but-unsent outreach, so the Tracker/Directory show the
  // "Drafted" status alongside sent/responded ones.
  await addDoc(collection(db, `users/${user.uid}/outreaches`), {
    userId: user.uid,
    contactId: contactRefs['Sophia Turner'],
    type: 'Email',
    channel: 'Email',
    subject: 'Loved your Reality Labs growth thread',
    status: 'Drafted',
    nextFollowUpDate: null,
    responseReceived: null,
    dateOfResponse: null,
    meetingHeld: false,
    meetingDate: null,
    nextAction: 'Finish draft and send',
    referralGenerated: false,
    applicationLinked: null,
    notes: null,
    aiSummary: null,
    sentAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
    updatedAt: serverTimestamp()
  });

  // 5. An overdue and an upcoming follow-up so OutreachCalendar has content
  // on both sides of "today".
  await addDoc(collection(db, `users/${user.uid}/outreaches`), {
    userId: user.uid,
    contactId: contactRefs['James Taylor'],
    type: 'Follow-up',
    channel: 'Email',
    subject: 'Scheduled re-engagement',
    status: 'Pending Follow-Up',
    nextFollowUpDate: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
    responseReceived: null,
    dateOfResponse: null,
    meetingHeld: false,
    meetingDate: null,
    nextAction: 'Send a check-in note',
    referralGenerated: false,
    applicationLinked: null,
    notes: null,
    aiSummary: null,
    sentAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  await addDoc(collection(db, `users/${user.uid}/outreaches`), {
    userId: user.uid,
    contactId: contactRefs['Priya Nair'],
    type: 'Meeting',
    channel: 'Video Call',
    subject: 'Quarterly strategy sync',
    status: 'Meeting Scheduled',
    nextFollowUpDate: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000),
    responseReceived: 'Yes',
    dateOfResponse: null,
    meetingHeld: false,
    meetingDate: null,
    nextAction: 'Prep talking points',
    referralGenerated: false,
    applicationLinked: null,
    notes: null,
    aiSummary: null,
    sentAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  // 6. A handful of notes so the Contact Detail timeline and AI context
  // (past meetings / "they mentioned" tags) have real material to reference.
  const noteRef = collection(db, `users/${user.uid}/notes`);
  const notes: { name: string; content: string }[] = [
    { name: 'Sarah Chen', content: 'Quick call recap: she is actively looking at agent-tooling startups this quarter. Said to send anything relevant directly to her, no warm intro needed.' },
    { name: 'Elena Rodriguez', content: `**Meeting on ${now.toISOString().split('T')[0]}**\n- **Discussed:** Her move to the leveraged finance desk, my transition timeline.\n- **Promised:** Intro to a VP on the healthcare coverage team.\n- **Next Steps:** Follow up in two weeks if the intro has not landed.` },
    { name: 'Olivia Martinez', content: 'Mentioned she is hiring two senior engineers for her org in Q3 and is happy to fast-track referrals from our circle.' },
    { name: 'Jessica Miller', content: 'Sent over two case interview frameworks. Said to practice the market-sizing one out loud before our next call.' },
    { name: 'Michael Chen', content: 'Read his macro thread on rate-cut positioning before reaching out — referenced it directly and he responded same day.' },
    { name: 'James Taylor', content: 'Last real conversation was at a conference in 2023. Worth a short, low-pressure note to re-open the line.' },
  ];

  for (const note of notes) {
    const contactId = contactRefs[note.name];
    if (!contactId) continue;
    await addDoc(noteRef, {
      userId: user.uid,
      contactId,
      content: note.content,
      createdAt: serverTimestamp()
    });
  }

  return true;
}
