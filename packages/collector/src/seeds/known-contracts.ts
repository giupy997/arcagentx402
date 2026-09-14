/**
 * Address labels. Source of truth: https://docs.arc.io/arc/references/contract-addresses and the
 * ERC-8004 / ERC-8183 tutorials, read on 2026-09-14. Testnet only: the docs publish no mainnet
 * addresses yet. Mainnet USDC is listed as an assumption to be verified at launch.
 */
export interface KnownContract {
  network: "testnet" | "mainnet";
  address: string;
  label: string;
  protocol: string;
  source: string;
}

const DOCS = "docs.arc.io/arc/references/contract-addresses (2026-09-14)";
const T = (address: string, label: string, protocol: string, source = DOCS): KnownContract => ({ network: "testnet", address, label, protocol, source });

export const KNOWN_CONTRACTS: readonly KnownContract[] = [
  T("0x3600000000000000000000000000000000000000", "USDC", "circle"),
  T("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", "EURC", "circle"),
  T("0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C", "USYC", "circle"),
  T("0xCC205224862C7641930c87679E98999d23C26113", "USYC Entitlements", "circle"),
  T("0x9fdF14c5B14173D74C08Af27AebFf39240dC105A", "USYC Teller", "circle"),
  T("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", "TokenMessengerV2", "cctp"),
  T("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275", "MessageTransmitterV2", "cctp"),
  T("0xb43db544E2c27092c107639Ad201b3dEfAbcF192", "TokenMinterV2", "cctp"),
  T("0xbaC0179bB358A8936169a63408C8481D582390C4", "MessageV2", "cctp"),
  T("0x0077777d7EBA4688BDeF3E311b846F25870A19B9", "GatewayWallet", "gateway"),
  T("0x0022222ABE238Cc2C7Bb1f21003F0a260052475B", "GatewayMinter", "gateway"),
  T("0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10", "FxEscrow", "stablefx"),
  T("0x5294E9927c3306DcBaDb03fe70b92e01cCede505", "Memo", "arc-extensions"),
  T("0x522fAf9A91c41c443c66765030741e4AaCe147D0", "Multicall3From", "arc-extensions"),
  T("0x4e59b44847b379578588920cA78FbF26c0B4956C", "CREATE2 Factory (Arachnid)", "common"),
  T("0xcA11bde05977b3631167028862bE2a173976CA11", "Multicall3", "common"),
  T("0x000000000022D473030F116dDEE9F6B43aC78BA3", "Permit2", "common"),
  T("0x8004A818BFB912233c491871b3d84c89A494BD9e", "ERC-8004 IdentityRegistry", "erc8004", "docs.arc.io/arc/tutorials/register-your-first-ai-agent (2026-09-14)"),
  T("0x8004B663056A597Dffe9eCcC1965A193B7388713", "ERC-8004 ReputationRegistry", "erc8004", "docs.arc.io/arc/tutorials/register-your-first-ai-agent (2026-09-14)"),
  T("0x8004Cb1BF31DAf7788923b405b754f57acEB4272", "ERC-8004 ValidationRegistry", "erc8004", "docs.arc.io/arc/tutorials/register-your-first-ai-agent (2026-09-14)"),
  T("0x0747EEf0706327138c69792bF28Cd525089e4583", "ERC-8183 AgenticCommerce (reference)", "erc8183", "docs.arc.io/arc/tutorials/create-your-first-erc-8183-job (2026-09-14)"),
  T("0xfffffffffffffffffffffffffffffffffffffffe", "System address (EIP-7708 native Transfer logs)", "arc-system", "observed in testnet receipts (2026-09-14)"),
  { network: "mainnet", address: "0x3600000000000000000000000000000000000000", label: "USDC (UNVERIFIED: assumed same predeploy as testnet)", protocol: "circle", source: "assumption; verify on docs.arc.io at launch" },
  { network: "mainnet", address: "0xfffffffffffffffffffffffffffffffffffffffe", label: "System address (EIP-7708 native Transfer logs)", protocol: "arc-system", source: "observed on testnet; verify on mainnet" },
];
