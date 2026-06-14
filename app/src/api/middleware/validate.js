const { z } = require('zod');

const BENEFIT_CATEGORIES = ['MEDICAL', 'DENTAL', 'VISION', 'MENTAL_HEALTH', 'PRESCRIPTION'];

const claimItemSchema = z.object({
  serviceType: z.string().min(1),
  benefitCategory: z.enum(BENEFIT_CATEGORIES),
  billedAmount: z.number().positive(),
  description: z.string().max(500).optional()
});

const claimSubmissionSchema = z.object({
  memberId: z.string().min(1),
  policyId: z.string().min(1),
  dateOfService: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  providerId: z.string().optional(),
  providerName: z.string().optional(),
  diagnosisCodes: z.array(z.string()).optional(),
  items: z.array(claimItemSchema).min(1, 'At least one item required')
});

const memberCreationSchema = z.object({
  name: z.string().min(1).max(200),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD'),
  memberId: z.string().min(1).max(50),
  policyId: z.string().min(1).optional()
});

const coverageRuleSchema = z.object({
  benefitCategory: z.enum(BENEFIT_CATEGORIES),
  serviceTypes: z.array(z.string()).default([]),
  coveredPercent: z.number().min(0).max(100),
  annualLimit: z.number().positive(),
  annualDeductible: z.number().min(0).default(0),
  requiresPreAuth: z.boolean().default(false),
  requiresManualReview: z.boolean().default(false)
});

const policyVersionSchema = z.object({
  effectiveFrom: z.string(),
  changeReason: z.string().optional(),
  isRetroactive: z.boolean().default(false),
  coverageRules: z.array(coverageRuleSchema).min(1)
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
    }
    req.body = result.data;
    next();
  };
}

module.exports = {
  validateClaimSubmission: validate(claimSubmissionSchema),
  validateMemberCreation: validate(memberCreationSchema),
  validatePolicyVersion: validate(policyVersionSchema)
};
