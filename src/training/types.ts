/**
 * Training Lab type definitions.
 *
 * Mirrors `simocracy-v2/lib/training/types.ts` byte-for-byte (modulo
 * import paths). Keep in sync — drift here means the CLI builds a
 * different state shape than the web app for the same sim.
 */

export type Vote = "yes" | "no" | "abstain";

export interface BaselineProposal {
  id: string;
  title: string;
  summary: string;
  topic: string;
}

export interface BaselineVote {
  proposalId: string;
  vote: Vote;
  importance: number;
  reasoning: string;
}

export interface InterviewTurn {
  role: "assistant" | "user";
  content: string;
  target?: "values" | "tradeoffs" | "red_lines" | "uncertainty" | "priority";
}

/**
 * A turn in the Feedback tab — the user chats directly with the sim
 * (in character) to give concrete feedback on the constitution.
 * "Apply feedback" then synthesises the transcript into a
 * constitution rewrite. Identical wire shape to InterviewTurn but
 * separately named so the two transcripts don't get mixed in storage.
 */
export interface FeedbackTurn {
  role: "assistant" | "user";
  content: string;
}

export interface IssuePriority {
  issue: string;
  stance: string;
  importance: number;
  negotiability: number;
  confidence: number;
}

export interface TrainingProfile {
  summary: string;
  coreValues: string[];
  issuePriorities: IssuePriority[];
  redLines: string[];
  acceptableTradeoffs: string[];
  uncertaintyAreas: string[];
  representationRules: string[];
}

export interface AlignmentResult {
  matchedCount: number;
  totalCount: number;
  results: Array<{
    proposalId: string;
    userVote: Vote;
    simVote: Vote;
    matched: boolean;
    confidence: number;
    explanation: string;
  }>;
  weakAreas: string[];
}

export type BaselineQuestionSet =
  | { source: "default"; proposals: BaselineProposal[] }
  | {
      source: "template";
      templateUri: string;
      templateName: string;
      proposals: BaselineProposal[];
    };

export interface TrainingLabState {
  baselineVotes: BaselineVote[];
  interviewTurns: InterviewTurn[];
  feedbackTurns?: FeedbackTurn[];
  profile: TrainingProfile | null;
  alignment: AlignmentResult | null;
  questionSet?: BaselineQuestionSet;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Interview templates (mirrors simocracy-v2's lib/lexicon-types.ts subset)
// ---------------------------------------------------------------------------

export type InterviewQuestionType = "open" | "text" | "yesNo";

export interface InterviewQuestion {
  id: string;
  type: InterviewQuestionType;
  prompt: string;
  required?: boolean;
}

export interface InterviewTemplateRecord {
  $type: "org.simocracy.interviewTemplate";
  name: string;
  description?: string;
  questions: InterviewQuestion[];
  createdAt: string;
}

export interface LoadedInterviewTemplate {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  template: InterviewTemplateRecord;
}
