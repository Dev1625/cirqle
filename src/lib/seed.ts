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

  // Sample Data Sets
  const people = [
    { name: 'Sarah Chen', company: 'Sequoia Capital', role: 'Partner', industry: 'Venture Capital', tier: 'Warm', summary: 'Met at SaaStr Annual. Focuses on AI enterprise tooling.' },
    { name: 'Marcus Johnson', company: 'McKinsey & Co', role: 'Engagement Manager', industry: 'Consulting', tier: 'Cold', summary: 'Reached out over LinkedIn regarding digital transformation practices.' },
    { name: 'Elena Rodriguez', company: 'Goldman Sachs', role: 'Vice President', industry: 'Investment Banking', tier: 'Strong', summary: 'Former colleague from college. Grabbing coffee next month.' },
    { name: 'David Smith', company: 'Stripe', role: 'Product Manager', industry: 'Technology', tier: 'Cold', summary: 'Trying to get a referral for the TPM role.' },
    { name: 'Jessica Miller', company: 'Bain & Company', role: 'Associate Partner', industry: 'Consulting', tier: 'Warm', summary: 'Introduced by Greg. Helpful with case prep.' },
    { name: 'Tom Davis', company: 'Blackstone', role: 'Principal', industry: 'Private Equity', tier: 'Cold', summary: 'Cold emailed about their recent tech acquisitions.' },
    { name: 'Emily Wilson', company: 'a16z', role: 'Deal Partner', industry: 'Venture Capital', tier: 'Warm', summary: 'Chatted briefly at Demo Day.' },
    { name: 'James Taylor', company: 'Morgan Stanley', role: 'Managing Director', industry: 'Investment Banking', tier: 'Dormant', summary: 'Haven\'t spoken since 2023. Need to re-engage.' },
    { name: 'Olivia Martinez', company: 'Google', role: 'Engineering Director', industry: 'Technology', tier: 'Strong', summary: 'Mentor. Meets every quarter.' },
    { name: 'Alex Johnson', company: 'KKR', role: 'Associate', industry: 'Private Equity', tier: 'Warm', summary: 'Went to the same undergrad. Active in alumni group.' }
  ];

  const now = new Date();
  
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
      tags: [],
      location: null,
      email: null,
      linkedinUrl: null,
      subIndustry: null,
      lastContactedAt: null,
      seniority: null,
      school: null,
      connectionSource: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

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
       let nextAct = 'Follow up with times';
       
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

  return true;
}
