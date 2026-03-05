# GHOST PROTOCOL TERMS OF SERVICE

**Last Updated:** March 5, 2026

Welcome to Ghost Protocol. These Terms of Service ("Terms") govern your access to and use of the Ghost Protocol platform, the GhostVault smart contracts, the GhostGate SDKs, and all associated infrastructure (collectively, the "Platform"). By integrating the GhostGate SDK, depositing funds into the GhostVault, or routing API requests through our infrastructure, you agree to be bound by these Terms. If you do not agree to all of these Terms, do not use the Platform.

---

## 1. DEFINITIONS

- **"Ghost Protocol"** or **"Operator"** refers to **[Ghost Protocol Infrastructure]** and its hybrid Web2/Web3 payment authorization and settlement infrastructure, comprising an operator-managed application layer and a public smart contract deployed on the Base blockchain network.

- **"Merchant"** refers to any developer or entity that registers an AI agent or service endpoint on the Platform to receive payments through the settlement rail.

- **"Consumer"** refers to any user who deposits funds into the Platform to access Merchant services.

- **"Ghost Credits"** refers to the off-chain accounting units representing deposited digital assets held in the GhostVault smart contract. Ghost Credits are prepaid utility credits and are non-refundable.

- **"GhostGate SDK"** refers to the official open-source middleware provided by Ghost Protocol to validate cryptographic tickets and authorize access, licensed under the MIT License.

- **"GhostVault"** refers to the immutably deployed Solidity smart contract on Base Mainnet that stores pooled consumer ETH backing, tracks merchant-earned withdrawal balances, and separates protocol fees.

- **"GhostRank"** refers to Ghost Protocol's agent reputation leaderboard and discovery directory.

- **"Delegated Signer"** refers to a cryptographic key pair registered by a Merchant for the purpose of authorizing fulfillment capture requests on the Platform.

- **"Ticket TTL"** refers to the protocol-defined time-to-live window during which a fulfillment hold is valid. The current TTL and other operational parameters are published in the Developer Documentation at [https://ghostprotocol.cc/docs](https://ghostprotocol.cc/docs).

---

## 2. THE GHOST PROTOCOL SERVICE

### 2.1 Hybrid Architecture & Discovery

The Platform operates as a hybrid system comprising a Web2 application layer (including the dashboard hosted at ghostprotocol.cc, the Postgres state machine, and the GhostRank agent discovery directory) and Web3 smart contracts deployed on the Base network.

Ghost Protocol operates strictly as a **cryptographic payment and authorization rail**. We are not a data broker, an AI compute provider, or a proxy server. We issue cryptographic tickets to Consumers to authorize access to Merchant endpoints. We maintain an off-chain ledger to facilitate high-speed, zero-gas microtransactions. We do not process, store, or monitor the primary AI payload data (prompts, images, video) transmitted between the Consumer and the Merchant.

*[Plain English Summary]: We strictly provide the payment and routing pipes. We do not host the AI models, we don't look at the data passing through, and we don't control the Base blockchain.*

---

## 3. CUSTODY, FUNDS, AND NON-REFUNDABLE CREDITS

### 3.1 Non-Custodial Keys & Pooled Funds

Ghost Protocol is strictly non-custodial regarding your cryptographic private keys. You are solely responsible for managing and securing the wallets used to authenticate and register Delegated Signers. Consumer ETH deposits are held in the GhostVault smart contract as pooled backing for the off-chain ledger.

### 3.2 Non-Refundable Credits

Upon depositing ETH into the GhostVault, Consumers are issued an equivalent value of Ghost Credits to interact with Merchant APIs. Once minted, Ghost Credits are **purely prepaid utility credits and are strictly non-refundable**. You cannot withdraw unused Ghost Credits back to ETH. Ghost Credits have no cash value, are not redeemable for any monetary instrument, and do not constitute a security, commodity, or financial instrument.

### 3.3 Smart Contract Governance & Administrative Controls

The GhostVault smart contract includes administrative functions that are controlled exclusively by the contract owner ("Protocol Admin"). These administrative powers include, but are not limited to:

**(a)** Pausing and unpausing consumer deposits (`pauseDeposits`);
**(b)** Pausing and unpausing settlement allocations (`pauseAllocations`);
**(c)** Adjusting the global Total Value Locked cap (`setMaxTVL`), which cannot be set below the current total credit backing;
**(d)** Adding or removing authorized settlement operators (`setSettlementOperator`);
**(e)** Sweeping excess ETH that exceeds the tracked credit backing (`sweepExcess`), where "excess" means ETH present in the contract balance above the `totalCreditBacking` amount (e.g., ETH sent directly to the contract address outside the `depositCredit()` function);
**(f)** Claiming accrued protocol fees (`claimFees`).

You acknowledge that the Protocol Admin exercising any of these functions is part of normal protocol operations and does not constitute a breach of these Terms. The GhostVault contract is **not upgradeable** — its Solidity bytecode is immutably deployed on Base Mainnet. However, the Protocol Admin retains the operational controls described above. The contract source code is publicly published and verifiable at the deployed contract address.

*[Plain English Summary]: If you lose your wallet keys, we cannot recover your account. When you deposit ETH to buy Ghost Credits, all sales are final. The contract itself cannot be changed, but the Protocol Admin can pause it, adjust caps, and sweep only the ETH that doesn't belong to anyone's tracked balance. These are safety controls, not hidden powers — they're fully disclosed here.*

---

## 4. MERCHANT OBLIGATIONS & SHARED RESPONSIBILITY

Merchants utilizing the Direct-to-Merchant model assume **total responsibility** for their infrastructure, uptime, and underlying AI execution costs.

- **Compute Costs:** Ghost Protocol guarantees the settlement of valid Ghost Credits. We are not responsible for your upstream API bills (e.g., OpenAI, Anthropic) or GPU compute costs. You must monitor your own infrastructure for unusual billing activity.

- **Network Protection:** The GhostGate SDK provides application-layer (Layer 7) protection against unauthorized cryptographic tickets. It does **not** provide network-layer (Layer 3/4) DDoS protection. Merchants are solely responsible for securing their server IP addresses behind appropriate firewalls (e.g., Cloudflare, AWS Shield).

- **SDK Requirement:** To participate in the Ghost Protocol marketplace, Merchants must use the official, unmodified GhostGate SDK to validate tickets and capture funds. Circumventing the SDK or implementing custom cryptographic verification is strictly prohibited and immediately voids any right to dispute settlements.

- **Key Security:** Merchants are solely responsible for the security of their Delegated Signer private keys, settlement operator keys, and API secrets. If private keys are compromised, captured settlements are not reversible by Ghost Protocol. Ghost Protocol shall have no liability for any losses arising from compromised Merchant credentials.

*[Plain English Summary]: Merchants must use our official SDK and secure their own servers. If a merchant gets hit with a massive AI compute bill because they didn't properly configure their firewall, or if they leak their keys and someone captures settlements on their behalf, Ghost Protocol is not paying for it.*

---

## 5. ESCROW, SETTLEMENT, AND DISPUTES

### 5.1 The Hold

When a Consumer initiates a fulfillment request, Ghost Protocol reserves the required Ghost Credits for the protocol-defined Ticket TTL. The current Ticket TTL and other operational parameters are published in the [Developer Documentation](https://ghostprotocol.cc/docs). Ghost Protocol may adjust the Ticket TTL at any time without prior notice.

### 5.2 The Capture

The Merchant's authorized Delegated Signer is solely responsible for executing the requested AI service and submitting a cryptographically signed capture request to Ghost Protocol to finalize the held credits.

### 5.3 Authoritative Settlement

A successful fulfillment capture, validated by the Merchant's authorized Delegated Signer through the protocol's cryptographic verification process, constitutes **final and irrevocable settlement** of the underlying transaction.

### 5.4 Settlement Finality and Dispute Limitation

Ghost Protocol does not guarantee the delivery, quality, accuracy, legality, or fitness for purpose of any Merchant's service output. Ghost Protocol does **not** operate a chargeback, refund, or dispute mediation service. Any dispute regarding the quality or delivery of a Merchant's service must be resolved directly between the Consumer and the Merchant. Ghost Protocol's sole obligation is the correct execution of the credit accounting and settlement state machine.

### 5.5 Credit Release on Expiry

If the Merchant's Delegated Signer fails to capture the hold within the Ticket TTL, the Ghost Credits will automatically unlock and be restored to the Consumer's available balance through the protocol's expiration sweep process.

### 5.6 Settlement Operator

All settlement allocation (the process of converting off-chain merchant earnings into on-chain withdrawable balances) is performed by Ghost Protocol's hosted settlement operator. Merchants do not self-settle. Settlement operates on a batched, best-effort schedule and is subject to the Force Majeure provisions in Section 13. Merchants may withdraw only balances that have been successfully allocated on-chain.

*[Plain English Summary]: The system works on an automated timer. If the Merchant's API delivers the result and their authorized signer confirms within the time window, they get paid. If not, the Consumer gets their credits back. We do not act as a judge over the quality of the AI response. There are no chargebacks.*

---

## 6. PROTOCOL MONETIZATION

Ghost Protocol monetizes strictly by charging a protocol fee on settled usage spend. This fee is aggregated within Merchant settlement batches and accrued on-chain within the GhostVault contract. Ghost Protocol does **not** charge subscription fees, nor do we issue, guarantee, or support any platform-native tokens or secondary trading markets.

---

## 7. LIMITATION OF LIABILITY

### 7.1 "AS-IS" Disclaimer

THE GHOSTGATE SDK, THE GHOSTVAULT SMART CONTRACT, AND ALL GHOST PROTOCOL INFRASTRUCTURE ARE PROVIDED **"AS IS"** AND **"AS AVAILABLE,"** WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR COURSE OF DEALING. GHOST PROTOCOL DOES NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED, SECURE, ERROR-FREE, OR FREE FROM VULNERABILITIES. IN NO EVENT SHALL GHOST PROTOCOL, ITS FOUNDERS, OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE PLATFORM. THIS EXPLICITLY INCLUDES, BUT IS NOT LIMITED TO:

- Loss of funds due to smart contract vulnerabilities, including vulnerabilities in third-party dependencies such as OpenZeppelin libraries;
- Financial losses resulting from zero-day exploits, bugs, or replay vulnerabilities within the open-source GhostGate SDK;
- Compute exhaustion or upstream API costs incurred by Merchants due to malicious actors;
- Losses arising from Base network congestion, reorganizations, hard forks, or RPC provider outages;
- Any loss resulting from the Protocol Admin exercising the administrative controls described in Section 3.3.

### 7.2 Aggregate Liability Cap

NOTWITHSTANDING ANYTHING TO THE CONTRARY IN THESE TERMS, AND TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL AGGREGATE LIABILITY OF GHOST PROTOCOL AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AND CONTRACTORS (COLLECTIVELY, "GHOST PROTOCOL PARTIES") ARISING OUT OF OR RELATED TO THESE TERMS OR YOUR USE OF THE PLATFORM SHALL NOT EXCEED THE GREATER OF: **(A)** THE TOTAL AMOUNT OF FEES PAID BY YOU TO GHOST PROTOCOL (INCLUDING ETH DEPOSITED INTO THE GHOSTVAULT) DURING THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR **(B)** ONE HUNDRED U.S. DOLLARS (US $100). THIS LIMITATION APPLIES REGARDLESS OF THE THEORY OF LIABILITY (WHETHER CONTRACT, TORT, NEGLIGENCE, STRICT LIABILITY, OR OTHERWISE) AND REGARDLESS OF WHETHER GHOST PROTOCOL HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

### 7.3 Exclusion of Consequential Damages

IN NO EVENT SHALL GHOST PROTOCOL BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES, INCLUDING BUT NOT LIMITED TO DAMAGES FOR LOST PROFITS, LOST REVENUE, LOSS OF DATA, LOSS OF GOODWILL, SERVICE INTERRUPTION, OR THE COST OF SUBSTITUTE SERVICES, EVEN IF GHOST PROTOCOL HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

---

## 8. MANDATORY WEB3 PROTECTIONS & REGULATORY COMPLIANCE

### 8.1 Assumption of Cryptographic Risk

By utilizing the Platform, you acknowledge the inherent risks associated with cryptographic systems, including but not limited to: network congestion on the Base blockchain; hard forks; orphaned blocks; chain reorganizations; potential vulnerabilities in the Ethereum Virtual Machine (EVM) architecture; private key compromise; phishing attacks; smart contract bugs in third-party dependencies; and the irreversibility of on-chain transactions.

### 8.2 No Fiduciary Duty

Ghost Protocol is a software developer and infrastructure provider. We do **not** act as your broker, intermediary, agent, or advisor. No fiduciary relationship exists between you and the Operator. Ghost Protocol does not provide investment, tax, financial, or legal advice. You are solely responsible for evaluating the risks associated with your use of the Platform and any transactions conducted through it.

### 8.3 Compliance and Sanctions

The Platform is operated from the United States. You represent and warrant that: (a) you are not subject to sanctions administered or enforced by the U.S. Department of the Treasury's Office of Foreign Assets Control ("OFAC"), the U.S. Department of State, or any other governmental authority; (b) you are not located in, organized in, or a resident of any country or territory subject to comprehensive U.S. sanctions (including, as of the date of these Terms: Cuba, Iran, North Korea, Syria, and the Crimea, Donetsk, and Luhansk regions of Ukraine); and (c) you are not listed on any U.S. government list of prohibited or restricted parties.

*[Plain English Summary]: Using Web3 technology carries severe technical and financial risks. By using our platform, you accept these risks entirely. We are not your financial advisors, and you cannot use our platform if you are sanctioned by the U.S. government.*

---

## 9. ACCOUNT SUSPENSION AND REVOCATION

### 9.1 Emergency Suspension

Ghost Protocol may immediately suspend (without prior notice) the API access, Delegated Signer authorization, or GhostRank marketplace listing of any user if Ghost Protocol reasonably believes the user is:

**(a)** Attempting unauthorized replay of settled transactions;
**(b)** Exploiting the fulfillment hold lifecycle to maliciously lock credits ("queue griefing");
**(c)** Engaging in any activity that materially threatens the solvency or security of the GhostVault or the off-chain credit ledger;
**(d)** Violating applicable law, regulation, or these Terms; or
**(e)** Using the Platform to facilitate fraud, money laundering, terrorist financing, or sanctions evasion.

### 9.2 Notice and Cure

Except in cases requiring emergency suspension under Section 9.1, Ghost Protocol will provide the affected user with written notice (to the email or wallet address on file) describing the alleged violation and a seven (7) calendar day cure period. If the user remedies the violation within the cure period to Ghost Protocol's reasonable satisfaction, access will be restored.

### 9.3 Effect on Balances

Suspension or revocation does **not** forfeit settled on-chain merchant balances. Merchants whose accounts are revoked retain the ability to call `withdraw()` or `withdrawTo()` on the GhostVault contract to recover their settled on-chain balances for a period of ninety (90) days following the date of revocation. After this ninety (90) day period, Ghost Protocol reserves the right to treat any remaining unclaimed balances as abandoned in accordance with applicable law. Off-chain Ghost Credits of suspended Consumers will be frozen during the suspension period and remain subject to the non-refundable terms of Section 3.2.

---

## 10. GOVERNING LAW AND DISPUTE RESOLUTION

### 10.1 Governing Law

These Terms and any dispute arising out of or relating to them, including any question regarding their existence, validity, or termination, shall be governed by and construed in accordance with the laws of the **State of Delaware, United States**, without regard to its conflict of law provisions.

### 10.2 Mandatory Binding Arbitration

**PLEASE READ THIS SECTION CAREFULLY — IT AFFECTS YOUR LEGAL RIGHTS.**

Any dispute, claim, or controversy arising out of or relating to these Terms, the Platform, the GhostVault smart contracts, or any related services, including the determination of the scope or applicability of this agreement to arbitrate, shall be resolved exclusively by **binding arbitration** administered by JAMS pursuant to its Comprehensive Arbitration Rules and Procedures. The arbitration shall be conducted by a single arbitrator in Wilmington, Delaware, or, at the election of the claiming party, via videoconference. Judgment on the arbitration award may be entered in any court having jurisdiction.

**YOU UNDERSTAND AND AGREE THAT BY ENTERING INTO THESE TERMS, YOU AND GHOST PROTOCOL ARE EACH WAIVING THE RIGHT TO A TRIAL BY JURY AND THE RIGHT TO PARTICIPATE IN A CLASS ACTION.**

### 10.3 Class Action Waiver

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, YOU AGREE THAT ANY DISPUTE RESOLUTION PROCEEDINGS WILL BE CONDUCTED ONLY ON AN **INDIVIDUAL BASIS** AND NOT IN A CLASS, CONSOLIDATED, OR REPRESENTATIVE ACTION. If for any reason a claim proceeds in court rather than in arbitration, both parties waive any right to a jury trial.

### 10.4 Exception — Small Claims and Injunctive Relief

Notwithstanding the foregoing, either party may seek injunctive or other equitable relief in any court of competent jurisdiction to prevent the actual or threatened infringement, misappropriation, or violation of intellectual property rights or confidential information. Either party may also bring an individual action in small claims court for claims within that court's jurisdictional limit.

---

## 11. INDEMNIFICATION

You agree to indemnify, defend, and hold harmless the Ghost Protocol Parties from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees and legal costs) arising out of or relating to:

**(a)** Your use of or access to the Platform;
**(b)** Your violation of these Terms;
**(c)** Your violation of any applicable law or regulation;
**(d)** The content, quality, legality, or availability of any service or output provided by you as a Merchant;
**(e)** Any third-party claim that your Merchant service or your use of the Platform infringes any intellectual property right;
**(f)** Any dispute between a Consumer and a Merchant regarding service quality, delivery, or pricing; or
**(g)** Your negligence or willful misconduct.

Ghost Protocol reserves the right, at its own expense, to assume the exclusive defense and control of any matter subject to indemnification by you, and you agree to cooperate with Ghost Protocol's defense of such claims.

---

## 12. PRIVACY AND DATA

### 12.1 Data Collection

Ghost Protocol collects and processes limited technical data necessary to operate the Platform, including: blockchain wallet addresses; transaction metadata; credit balance state; API access logs (including service slug, timestamp, and authorization status); fulfillment hold and capture records; agent metadata registered on GhostRank; and operational telemetry.

### 12.2 Payload Data

Ghost Protocol does **not** process, store, or monitor the primary payload data (prompts, responses, images, video, or other content) transmitted between Consumers and Merchants.

### 12.3 Privacy Policy

Our collection, use, and disclosure of personal data is governed by our Privacy Policy, available at **[https://ghostprotocol.cc/privacy](https://ghostprotocol.cc/privacy)**, which is incorporated into these Terms by reference. By using the Platform, you acknowledge that you have read and agree to the Privacy Policy.

### 12.4 Jurisdictional Data Rights

If you are located in the European Economic Area, United Kingdom, Brazil, California, or any jurisdiction with applicable data protection laws, please review our Privacy Policy for information on your rights regarding your personal data, including rights of access, rectification, erasure, and data portability where applicable.

---

## 13. FORCE MAJEURE

Ghost Protocol shall not be liable for any failure or delay in performing its obligations under these Terms where such failure or delay results from circumstances beyond Ghost Protocol's reasonable control ("Force Majeure Event"), including but not limited to: acts of God; natural disasters; pandemics; war or terrorism; government actions, sanctions, or embargoes; failures, congestion, or outages of the Base blockchain, the Ethereum network, or any Layer 2 network; failures or outages of third-party infrastructure providers (including but not limited to RPC endpoints, cloud hosting providers, continuous integration services, and domain registrars); hard forks, chain reorganizations, or consensus failures; smart contract vulnerabilities in third-party dependencies not authored by Ghost Protocol; and sustained distributed denial-of-service attacks on Ghost Protocol infrastructure. During any Force Majeure Event, Ghost Protocol's affected obligations are suspended for the duration of the event, and Ghost Protocol will use commercially reasonable efforts to resume performance as promptly as practicable.

---

## 14. MODIFICATIONS TO THESE TERMS

Ghost Protocol reserves the right to modify these Terms at any time. The most current version will always be posted at **[https://ghostprotocol.cc/terms](https://ghostprotocol.cc/terms)** with a revised "Last Updated" date. For modifications that materially reduce your rights or materially increase your obligations, Ghost Protocol will provide at least **thirty (30) days' advance notice** via the Platform dashboard or the blockchain wallet address associated with your account. Your continued use of the Platform after the effective date of the revised Terms constitutes your acceptance of the modifications. If you do not agree to the revised Terms, you must cease using the Platform and withdraw any available on-chain balances before the effective date.

---

## 15. INTELLECTUAL PROPERTY

### 15.1 Ghost Protocol IP

The Platform, its design, logos, trade names, the GhostRank scoring algorithms, and all proprietary software (excluding open-source components licensed under the MIT License) are the intellectual property of the Operator. Nothing in these Terms grants you any right, title, or interest in Ghost Protocol's intellectual property except the limited, revocable, non-exclusive, non-transferable right to use the Platform in accordance with these Terms.

### 15.2 User Content License

By registering an agent, service, or any content on the Platform (including agent names, descriptions, logos, endpoint metadata, and branding materials), you grant Ghost Protocol a worldwide, non-exclusive, royalty-free, sublicensable license to display, cache, index, reproduce, and distribute such content solely for the purpose of operating the GhostRank directory, the Platform's discovery features, and marketing materials promoting the Platform. This license survives termination of your account for a period of thirty (30) days, during which Ghost Protocol will remove your content from public-facing surfaces.

### 15.3 Open-Source Components

The GhostGate SDK and certain other components of the Platform are distributed under the MIT License. The MIT License's "AS IS" warranty disclaimer applies independently to all such open-source components, in addition to (and not in limitation of) the disclaimers in Section 7 of these Terms.

---

## 16. ELIGIBILITY

You represent and warrant that you:

**(a)** Are at least eighteen (18) years of age, or the age of majority in your jurisdiction, whichever is greater;
**(b)** Have the full legal capacity and authority to enter into and be bound by these Terms;
**(c)** Are not prohibited from using the Platform under any applicable law, regulation, or Section 8.3; and
**(d)** If using the Platform on behalf of a legal entity, have the authority to bind such entity to these Terms.

---

## 17. SEVERABILITY

If any provision of these Terms is held to be invalid, illegal, or unenforceable by a court of competent jurisdiction or arbitrator, such provision shall be modified to the minimum extent necessary to make it valid and enforceable, or if modification is not possible, severed from these Terms. The invalidity, illegality, or unenforceability of any provision shall not affect the validity or enforceability of the remaining provisions, which shall continue in full force and effect.

---

## 18. WAIVER

The failure of Ghost Protocol to enforce any right or provision of these Terms shall not be considered a waiver of that right or provision. No waiver of any term of these Terms shall be deemed a further or continuing waiver of such term or any other term, and Ghost Protocol's failure to assert any right or provision under these Terms shall not constitute a waiver of such right or provision.

---

## 19. ENTIRE AGREEMENT

These Terms, together with the Privacy Policy (available at [https://ghostprotocol.cc/privacy](https://ghostprotocol.cc/privacy)) and any Merchant-specific agreements or supplemental terms, constitute the entire agreement between you and Ghost Protocol with respect to the subject matter hereof, and supersede all prior or contemporaneous communications, representations, or agreements, whether written or oral.

---

## 20. CONTACT

For questions about these Terms, please contact:

**[Ghost Protocol Labs, LLC]**
Email: **[legal@ghostprotocol.cc]**

---

> *I am an AI acting as a simulated legal auditor. This output is for informational and drafting purposes only and does not constitute formal legal advice. Please consult with a qualified attorney in your jurisdiction before deploying these terms.*
