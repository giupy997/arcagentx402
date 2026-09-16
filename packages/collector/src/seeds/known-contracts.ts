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
const MAINNET_DOCS = "docs.arc.io/arc/references/contract-addresses, mainnet tab (2026-09-16)";
const M = (address: string, label: string, protocol: string, source = MAINNET_DOCS): KnownContract => ({ network: "mainnet", address, label, protocol, source });

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
  // Mainnet, from docs.arc.io/arc/references/contract-addresses read 2026-09-16 (launch day).
  M("0x3600000000000000000000000000000000000000", "USDC", "circle"),
  M("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", "EURC", "circle"),
  M("0x8a5D989Bbb96929F689B0200f435f53dA42bF490", "USYC", "circle"),
  M("0xb69ecb156Dc0028198028c501340d5367845ca72", "USYC Entitlements", "circle"),
  M("0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b", "USYC Teller", "circle"),
  M("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", "TokenMessengerV2", "cctp"),
  M("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", "MessageTransmitterV2", "cctp"),
  M("0xfd78EE919681417d192449715b2594ab58f5D002", "TokenMinterV2", "cctp"),
  M("0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78", "MessageV2", "cctp"),
  M("0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE", "GatewayWallet", "gateway"),
  M("0x2222222d7164433c4C09B0b0D809a9b52C04C205", "GatewayMinter", "gateway"),
  M("0xe2E5F173576B513d994073CCbDaCBE027d43DFe6", "FxEscrow", "stablefx"),
  M("0x5294E9927c3306DcBaDb03fe70b92e01cCede505", "Memo", "arc-extensions"),
  M("0x522fAf9A91c41c443c66765030741e4AaCe147D0", "Multicall3From", "arc-extensions"),
  M("0x4e59b44847b379578588920cA78FbF26c0B4956C", "CREATE2 Factory (Arachnid)", "common"),
  M("0xcA11bde05977b3631167028862bE2a173976CA11", "Multicall3", "common"),
  M("0x000000000022D473030F116dDEE9F6B43aC78BA3", "Permit2", "common"),
  M("0xfffffffffffffffffffffffffffffffffffffffe", "System address (EIP-7708 native Transfer logs)", "arc-system", "observed on testnet; same predeploy expected on mainnet"),
];
