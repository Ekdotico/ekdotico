// The privacy notice of the application, at `/privacy` (FR-AU-72; owner's answers of 21 November 2026:
// fw-privacy-page, fw-privacy-text, fw-privacy-hosting, fw-privacy-gaps). The words are the approved base, verbatim:
// nothing here is added or reworded, and tests/unit/privacy-notice.test.ts pins the whole of it.
//
// The legal parts (the lawful basis, the person's rights, the right to complain, transfers, erasure and feedback)
// are added after the data protection review (fw-privacy-gaps), and the controller (name, legal form, address) is
// still owed by the owner: it would be a section of its own, between "Who this is for" and "What the application
// keeps about your account", and none is written here.
//
// The contact address is not here: it is `CONTACT_ADDRESS` in the environment (src/lib/settings.ts), the one source
// of the team's address, and the last section is left out while that is unset.

export const PRIVACY_TITLE = 'Privacy notice';

export interface PrivacySection {
  heading: string;
  text: string;
}

/** The sections before the contact line, in order. Each text is one paragraph, as approved. */
export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  {
    heading: 'Who this is for',
    text: 'Ekdotico is in Closed α, an early test release. This notice is for the people who have an account in it.',
  },
  {
    heading: 'What the application keeps about your account',
    text: "Your name, your email address and, if you added one, your avatar. A hash of your password, and, if you turned on two-factor authentication, its secret and its recovery codes. Each session you have open, with the browser and the network address it began from. The time at which you acknowledged the Closed α notice, and the version you acknowledged. The documents you write, their images, and the invitations and notifications that concern you. A record of security events, with your account identifier and no name or address, for 30 days. All of this is held in the application's own database in the Netherlands. The application has no identity provider outside itself.",
  },
  {
    heading: 'What happens when you send feedback',
    text: "Sending feedback is your choice, and there is no box to tick. Your message goes to the Ekdotico team with the kind of feedback you chose, the kind of page you were on, the Ekdotico version, your browser and its window size, and your account identifier. The content of your documents is not sent. Whatever you type in the message is sent as you typed it, so leave out anything you do not want the team to read. The application does not keep a copy of your feedback. The application sends it to Praktico, the team's internal tool, which stores it in a table of its own and shows it to the team. Feedback is kept until 12 months after the last Closed α release. The team can delete one submission on request.",
  },
  {
    heading: 'Who handles your data',
    text: 'DigitalOcean hosts the application and its storage in the Netherlands, and hosts Praktico in Frankfurt. Brevo sends the email the application sends you. Scaleway holds an encrypted copy of the backups, which it cannot read. The browser makes no request to any other service for the feedback widget.',
  },
  {
    heading: 'Backups',
    text: 'A copy of what the database holds is kept in backups for a recovery window after you delete it, so deleted data can still be restored for that window.',
  },
  {
    heading: 'Deleting your account',
    text: 'You can delete your account from your account settings. You are asked for your password again, and for a code if you use two-factor authentication. You cannot delete an account that owns a document: you first transfer the ownership of each document, or clear the documents, which deletes them for good. When your account is deleted, your name, email address and avatar are cleared, your password and your sessions are deleted, and nothing from which you could be found is put in their place. What you wrote in other people\'s documents stays, shown as "Deleted account". Your feedback stays, with your account identifier removed from it. Deleting an account in Closed α is not by itself an answer to a request to erase your data.',
  },
];

/** The heading of the last section, whose text is the team's contact address. */
export const PRIVACY_CONTACT_HEADING = 'How to reach the team';
