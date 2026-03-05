GHOST PROTOCOL TERMS OF SERVICE
Last Updated: 3/5/26

Welcome to Ghost Protocol. These Terms of Service ("Terms") govern your access to and use of the Ghost Protocol platform, the GhostVault smart contracts, the GhostGate SDKs, and all associated infrastructure (collectively, the "Platform"). By integrating the GhostGate SDK, depositing funds into the GhostVault, or routing API requests through our infrastructure, you agree to be bound by these Terms.


1. DEFINITIONS

"Ghost Protocol" refers to the decentralized payment and authorization routing infrastructure.

"Merchant" refers to any developer or entity that registers an Al agent or service endpoint on the Platform to receive payments.

"Consumer" refers to any user who deposits funds into the Platform to access Merchant services.

"Ghost Credits" refers to the off-chain accounting units representing deposited digital assets held in the GhostVault smart contract.

"GhostGate SDK" refers to the official open-source middleware provided by Ghost Protocol to validate cryptographic tickets and authorize access.


2. THE GHOST PROTOCOL SERVICE

2.1 Hybrid Architecture & Discovery The Platform operates as a hybrid system comprising a Web2 application layer (including the dashboard hosted at ghostprotocol.cc, the Postgres state machine, and the GhostRank agent discovery directory) and Web3 smart contracts deployed on the Base network. Ghost Protocol operates strictly as a cryptographic payment and authorization rail. We are not a data broker, an Al compute provider, or a proxy server. We issue cryptographic tickets to Consumers to authorize access to Merchant endpoints. We maintain an off-chain ledger to facilitate high-speed, zero-gas microtransactions. We do not process, store, or monitor the primary Al payload data (prompts, images, video) transmitted between the Consumer and the Merchant.

[Plain English Summary]: We strictly provide the payment and routing pipes. We do not host the AI models, we don't look at the data passing through, and we don't control the Base blockchain.


3. CUSTODY, FUNDS, AND NON-REFUNDABLE CREDITS

3.1 Non-Custodial Keys & Pooled Funds
Ghost Protocol is strictly non-custodial regarding your cryptographic private keys. You are solely responsible for managing and securing the wallets used to authenticate and register delegated signers. Consumer ETH deposits are held in the GhostVault smart contract as a pooled backing for the off-chain ledger.

3.2 Non-Refundable Credits
Upon depositing ETH into the GhostVault, Consumers are issued an equivalent value of Ghost Credits to interact with Merchant APIs. Once minted, Ghost Credits are purely prepaid utility credits and are strictly non-refundable.
[Plain English Summary]: If you lose your wallet keys, we cannot recover your account. When you deposit ETH to buy Ghost Credits, all sales are final. You cannot withdraw unused Ghost Credits back to ETH.


4. MERCHANT OBLIGATIONS & SHARED RESPONSIBILITY

Merchants utilizing the Direct-to-Merchant model assume total responsibility for their infrastructure, uptime, and underlying Al execution costs.

Compute Costs: Ghost Protocol guarantees the settlement of valid Ghost Credits. We are not responsible for your upstream API bills (e.g., OpenAl, Anthropic) or GPU compute costs. You must monitor your own infrastructure for unusual billing activity.

Network Protection: The GhostGate SDK provides application-layer (Layer 7) protection against unauthorized cryptographic tickets.  It does not provide network-layer (Layer 3/4) DDoS protection. Merchants are solely responsible for securing their server IP addresses behind appropriate firewalls (e.g., Cloudflare, AWS Shield).

SDK Requirement: To participate in the Ghost Protocol marketplace, Merchants must use the official, unmodified GhostGate SDK to validate tickets and capture funds. Circumventing the SDK or implementing custom cryptographic verification is strictly prohibited and immediately voids any right to dispute settlements.

[Plain English Summary]: Merchants must use our official SDK and secure their own servers. If a merchant gets hit with a massive AI compute bill from OpenAI because they didn't properly configure their firewall, Ghost Protocol is not paying for it.


5. ESCROW, SETTLEMENT, AND DISPUTES

Ghost Protocol utilizes a "Settle-on-Success" escrow model to protect both parties.  * The Hold: When a Consumer initiates a request, Ghost Protocol locks the required Ghost Credits for a maximum of 60 seconds (the "TTL").

The Capture: The Merchant's server is solely responsible for executing the requested Al service and firing the automated webhook back to Ghost Protocol to capture the held credits.

Authoritative Settlement: A successful capture webhook originating from the Merchant's server is considered authoritative proof of service completion. Ghost Protocol will not mediate disputes regarding the "quality" of the Al response or transient network drops that occur after the Merchant's server successfully executes the capture.

Release: If the Merchant's server fails to capture the hold within the 60-second TTL, the Ghost Credits will automatically unlock and be returned to the Consumer's available balance.

[Plain English Summary]: The system works on an automated 60-second timer. If the Merchant's API delivers the result and pings us within 60 seconds, they get paid. If not, the Consumer gets their credits back. We do not act as a judge over the quality of the AI response.


6. PROTOCOL MONETIZATION

Ghost Protocol monetizes strictly by charging a protocol fee on settled usage spend. This fee is aggregated within Merchant settlement batches and accrued on-chain. Ghost Protocol does not charge subscription fees, nor do we issue, guarantee, or support any platform-native tokens or secondary trading markets.


7. LIMITATION OF LIABILITY (THE SDK "AS-IS" CLAUSE)

THE GHOSTGATE SDK AND ALL GHOST PROTOCOL INFRASTRUCTURE ARE PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL GHOST PROTOCOL, ITS FOUNDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE PLATFORM. THIS EXPLICITLY INCLUDES, BUT IS NOT LIMITED TO:

Loss of funds due to smart contract vulnerabilities.

Financial losses resulting from zero-day exploits, bugs, or replay vulnerabilities within the open-source GhostGate SDK.

Compute exhaustion or upstream API costs incurred by Merchants due to malicious actors.


8. MANDATORY WEB3 PROTECTIONS & REGULATORY COMPLIANCE

8.1 Assumption of Cryptographic Risk
By utilizing the Platform, you acknowledge the inherent risks associated with cryptographic systems, including but not limited to network congestion on the Base blockchain, hard forks, orphaned blocks, and potential vulnerabilities in the Ethereum Virtual Machine (EVM) architecture.

8.2 No Fiduciary Duty
Ghost Protocol is a software developer and infrastructure provider. We do not act as your broker, intermediary, agent, or advisor. No fiduciary relationship exists between you and Ghost Protocol or its operating company, [Insert Operating Company Name, e.g., Ghost Protocol LLC].

8.3 Compliance and Sanctions
The Platform is operated from the United States. You represent and warrant that you are not subject to sanctions administered or enforced by the U.S. Department of the Treasury's Office of Foreign Assets Control (OFAC) or operating from a comprehensively sanctioned jurisdiction.

[Plain English Summary]: Using Web3 technology carries severe technical and financial risks. By using our platform, you accept these risks entirely. Furthermore, we are not your financial advisors, and you cannot use our platform if you are sanctioned by the U.S. government.


9. ACCOUNT REVOCATION

Ghost Protocol reserves the right to suspend or permanently revoke the API access, Delegated Signer keys, or Marketplace ranking of any Merchant or Consumer found to be exploiting the state machine, attempting replay attacks, or engaging in queue griefing to maliciously lock other users' credits.
