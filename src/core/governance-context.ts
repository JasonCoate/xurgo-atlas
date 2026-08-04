import { GovernanceSearchIndex, GovernanceSearchResult } from './governance-search.js';
import { GovernanceCorpusDiscovery, GovernanceDocument } from './governance-corpus.js';

export interface GovernanceContextPackage {
  taskDescription: string;
  primaryDocuments: GovernanceDocument[];
  supportingDocuments: GovernanceDocument[];
  applicableRules: string[];
  sourceReferences: Array<{
    id: string;
    title: string;
    path: string;
    type: string;
  }>;
  totalChars: number;
  truncated: boolean;
}

export class GovernanceContextAssembler {
  private readonly searchIndex: GovernanceSearchIndex;
  private readonly corpusDiscovery: GovernanceCorpusDiscovery;

  constructor(dbPath?: string) {
    this.searchIndex = new GovernanceSearchIndex(dbPath);
    this.corpusDiscovery = new GovernanceCorpusDiscovery();
  }

  async assembleContext(
    taskDescription: string,
    maxChars: number = 10000,
  ): Promise<GovernanceContextPackage> {
    await this.searchIndex.index();
    const searchResults = this.searchIndex.search(taskDescription, null, 20);
    const corpus = this.corpusDiscovery.discover();

    if (!corpus) {
      return {
        taskDescription,
        primaryDocuments: [],
        supportingDocuments: [],
        applicableRules: [],
        sourceReferences: [],
        totalChars: 0,
        truncated: false,
      };
    }

    const primaryDocs: GovernanceDocument[] = [];
    const supportingDocs: GovernanceDocument[] = [];
    const sourceRefs: Array<{ id: string; title: string; path: string; type: string }> = [];
    let totalChars = 0;
    let truncated = false;

    for (const result of searchResults.results) {
      const doc = corpus.documents.find(d => d.id === result.id);
      if (!doc || !doc.content) continue;

      const docChars = doc.content.length;
      if (totalChars + docChars > maxChars) {
        truncated = true;
        break;
      }

      const sourceRef = {
        id: doc.id,
        title: doc.title,
        path: doc.path,
        type: doc.type,
      };

      if (result.score > 0.7) {
        primaryDocs.push(doc);
      } else {
        supportingDocs.push(doc);
      }

      sourceRefs.push(sourceRef);
      totalChars += docChars;
    }

    const applicableRules = this.extractApplicableRules(primaryDocs, supportingDocs);

    return {
      taskDescription,
      primaryDocuments: primaryDocs,
      supportingDocuments: supportingDocs,
      applicableRules,
      sourceReferences: sourceRefs,
      totalChars,
      truncated,
    };
  }

  private extractApplicableRules(
    primaryDocs: GovernanceDocument[],
    supportingDocs: GovernanceDocument[],
  ): string[] {
    const rules: string[] = [];

    for (const doc of [...primaryDocs, ...supportingDocs]) {
      if (doc.content) {
        const ruleMatches = doc.content.match(/^#+\s+(.+)$/gm);
        if (ruleMatches) {
          rules.push(...ruleMatches.map(rule => rule.replace(/^#+\s+/, '')));
        }
      }
    }

    return [...new Set(rules)].slice(0, 10);
  }

  close(): void {
    this.searchIndex.close();
  }
}