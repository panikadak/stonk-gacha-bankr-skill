// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface Vm {
    function createSelectFork(string calldata rpcUrl, uint256 blockNumber) external returns (uint256 forkId);
    function envOr(string calldata name, bool defaultValue) external view returns (bool value);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory value);
    function deal(address account, uint256 newBalance) external;
    function load(address target, bytes32 slot) external view returns (bytes32 data);
    function store(address target, bytes32 slot, bytes32 value) external;
    function prank(address caller) external;
    function roll(uint256 newHeight) external;
    function skip(bool skipTest) external;
    function warp(uint256 newTimestamp) external;
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address account, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IStonkGacha {
    function BPS() external view returns (uint256);
    function BOUNTY_BPS() external view returns (uint256);
    function HOUSE_EDGE_BPS() external view returns (uint256);
    function MAX_DISTRIBUTE() external view returns (uint256);
    function MIN_CEILING_BPS() external view returns (uint256);
    function MIN_DISTRIBUTE() external view returns (uint256);
    function PACK_COUNT() external view returns (uint256);
    function RESERVE_BPS() external view returns (uint256);
    function RESOLVE_WINDOW() external view returns (uint256);
    function STAKER_BPS() external view returns (uint256);
    function TARGET_RTP_BPS() external view returns (uint256);
    function USD_UNIT() external view returns (uint256);
    function callbackGasLimit() external view returns (uint32);
    function claimPrize(uint256 requestId, uint256 minOut, uint256 deadline) external returns (uint256 stockOut);
    function claimRefund(uint256 requestId) external;
    function cumulativeFundedReserveUsdc() external view returns (uint256);
    function cumulativeProcessedProfitUsdc() external view returns (uint256);
    function distributeProfit(uint256 amountIn, uint256 minWethOut, uint256 deadline)
        external
        returns (uint256 bountyUsdc, uint256 retainedProfitUsdc, uint256 stakerProfitUsdc, uint256 wethToStakers);
    function distributableProfitUsdc() external view returns (uint256);
    function eligibleOffer(uint256 packIndex)
        external
        view
        returns (uint256 ceilingBps, address[] memory tokens, bytes32[] memory routeHashes);
    function entropy() external view returns (address);
    function entropyFee() external view returns (uint256);
    function entropyProvider() external view returns (address);
    function expireRequest(uint256 requestId) external;
    function freeReserveUsdc() external view returns (uint256);
    function fundReserve(uint256 amount) external;
    function multiplierBpsFor(uint256 roll) external pure returns (uint256);
    function offerHash(uint256 packIndex) external view returns (bytes32);
    function openPack(uint256 packIndex, uint256 minCeilingBps, bytes32 expectedOfferHash, bytes32 userRandomNumber)
        external
        payable
        returns (uint256 requestId);
    function owner() external view returns (address);
    function packPrice(uint256 packIndex) external pure returns (uint256);
    function protectedUsdc() external view returns (uint256);
    function refundClaimable(uint256 requestId) external view returns (uint256);
    function requestDelivery(uint256 requestId) external view returns (bytes32 routeHash, uint256 stockOut);
    function requestFunding(uint256 requestId) external view returns (uint96 maxPayoutUsdc, uint96 payoutUsdc);
    function requests(uint256 requestId)
        external
        view
        returns (
            address buyer,
            uint96 paidUsdc,
            uint64 openedAt,
            uint32 multiplierBps,
            uint32 ceilingBps,
            uint8 packIndex,
            uint8 status,
            address token,
            uint256 stockOut,
            uint256 randomWord
        );
    function salesPaused() external view returns (bool);
    function stockAdapter() external view returns (address);
    function stockLock() external view returns (address);
    function treasury() external view returns (address);
    function usdc() external view returns (address);
    function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) external;
}

interface IGachaTreasury {
    function BOUNTY_BPS() external view returns (uint256);
    function MAX_DISTRIBUTE() external view returns (uint256);
    function MIN_DISTRIBUTE() external view returns (uint256);
    function RESERVE_BPS() external view returns (uint256);
    function STAKER_BPS() external view returns (uint256);
    function gacha() external view returns (address);
    function isCanonicalFor(address expectedGacha) external view returns (bool);
    function owner() external view returns (address);
    function payoutToken(bytes32 routeHash) external view returns (address);
    function quotePayout(bytes32 routeHash, uint256 amountIn) external returns (uint256 amountOut);
    function quoteProfit(uint256 amountIn) external returns (uint256 amountOut);
    function slipstreamQuoter() external view returns (address);
    function slipstreamRouter() external view returns (address);
    function stockAdapter() external view returns (address);
    function stockLock() external view returns (address);
    function usdc() external view returns (address);
    function weth() external view returns (address);
}

interface IStockAdapter {
    function owner() external view returns (address);
    function quoter() external view returns (address);
    function router() external view returns (address);
    function stockLock() external view returns (address);
    function weth() external view returns (address);
}

/// @dev A deliberately tiny generic contract-account surface. All protocol calls in the lifecycle
/// test originate here, so the suite exercises the same inner-call shape a Bankr smart wallet uses.
contract BankrWalletHarness {
    error CallFailed(bytes reason);

    receive() external payable {}

    function execute(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        (bool ok, bytes memory returned) = target.call{value: value}(data);
        if (!ok) revert CallFailed(returned);
        return returned;
    }
}

/// @notice Standalone integration coverage for the immutable live Base Gacha deployment.
/// @dev This intentionally has no forge-std or source-repository dependency. Run B20 delivery with
/// `RUN_BASE_B20_FORK=1 base-forge test --match-path test/StonkGachaBankrFork.t.sol -vvv`.
contract StonkGachaBankrForkTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant FORK_BLOCK = 50_774_053;
    uint256 private constant CHAIN_ID = 8453;

    address private constant OWNER = 0x702ba46435D1E55B18440100BC81EB055574875e;
    address private constant GACHA = 0xfD2c0EAf1b4B46593a3887feC4aF30Ac4245687F;
    address private constant TREASURY = 0x5da6595E587aC968e8355E2f5312FBE1967D6e1c;
    address private constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant STOCK_LOCK = 0x4570F784d35ab06a0FA22F42bb6329fAA998a6BA;
    address private constant STOCK_ADAPTER = 0x3d3abC1569C260953a6f5D42102D2f330A41430c;
    address private constant ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address private constant QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;
    address private constant ENTROPY = 0x6E7D74FA7d5c90FEF9F0512987605a6d546181Bb;
    address private constant ENTROPY_PROVIDER = 0x52DeaA1c84233F7bb8C8A45baeDE41091c616506;
    address private constant ENTROPY_IMPLEMENTATION = 0x4ceD698548F7D068f2f6E92D66f404A8A10db83b;

    bytes32 private constant GACHA_CODEHASH = 0xf7f3ddfb5f472c771cefced05b08558ce3a68feecb28b7dfe417173fc2a01908;
    bytes32 private constant TREASURY_CODEHASH = 0x94d0bc2fd7f4b2bda20481ededb24193462754399f598208f68e27f62b4824c0;
    bytes32 private constant ENTROPY_PROXY_CODEHASH =
        0xa1bc6c93a3e72eacb608ed6ee310fa55db317bdcac1b8f87999cf78754730ffc;
    bytes32 private constant ENTROPY_IMPLEMENTATION_CODEHASH =
        0x3fa48e15f319dc39d223a8deedd6b56c774fabe21837882e27563326c726e1f1;
    bytes32 private constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    IStonkGacha private constant gacha = IStonkGacha(GACHA);
    IGachaTreasury private constant treasury = IGachaTreasury(TREASURY);
    IERC20Minimal private constant usdc = IERC20Minimal(USDC);

    error AssertionFailed(string reason);
    error TokenBalanceSlotNotFound();

    function setUp() public {
        if (!vm.envOr("RUN_BASE_B20_FORK", false)) vm.skip(true);
        string memory rpc = vm.envOr("BASE_FORK_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc, FORK_BLOCK);
    }

    function testDeploymentWiringAndPublishedTermsMatchThePinnedRelease() public view {
        _eq(block.chainid, CHAIN_ID, "wrong chain");
        _eq(block.number, FORK_BLOCK, "wrong fork block");
        _eq(GACHA.codehash, GACHA_CODEHASH, "gacha runtime changed");
        _eq(TREASURY.codehash, TREASURY_CODEHASH, "treasury runtime changed");
        _eq(ENTROPY.codehash, ENTROPY_PROXY_CODEHASH, "entropy proxy runtime changed");
        _eq(ENTROPY_IMPLEMENTATION.codehash, ENTROPY_IMPLEMENTATION_CODEHASH, "entropy implementation changed");
        _eq(
            address(uint160(uint256(vm.load(ENTROPY, EIP1967_IMPLEMENTATION_SLOT)))),
            ENTROPY_IMPLEMENTATION,
            "entropy implementation slot changed"
        );

        _eq(gacha.owner(), OWNER, "gacha owner mismatch");
        _eq(gacha.usdc(), USDC, "gacha USDC mismatch");
        _eq(gacha.stockLock(), STOCK_LOCK, "gacha StockLock mismatch");
        _eq(gacha.stockAdapter(), STOCK_ADAPTER, "gacha adapter mismatch");
        _eq(gacha.treasury(), TREASURY, "gacha Treasury mismatch");
        _eq(gacha.entropy(), ENTROPY, "gacha Entropy mismatch");
        _eq(gacha.entropyProvider(), ENTROPY_PROVIDER, "gacha Entropy provider mismatch");
        _eq(uint256(gacha.callbackGasLimit()), 500_000, "callback gas mismatch");
        _false(gacha.salesPaused(), "sales unexpectedly paused at pinned block");

        _eq(treasury.owner(), OWNER, "treasury owner mismatch");
        _eq(treasury.gacha(), GACHA, "treasury gacha mismatch");
        _eq(treasury.usdc(), USDC, "treasury USDC mismatch");
        _eq(treasury.weth(), WETH, "treasury WETH mismatch");
        _eq(treasury.stockLock(), STOCK_LOCK, "treasury StockLock mismatch");
        _eq(treasury.stockAdapter(), STOCK_ADAPTER, "treasury adapter mismatch");
        _eq(treasury.slipstreamRouter(), ROUTER, "treasury router mismatch");
        _eq(treasury.slipstreamQuoter(), QUOTER, "treasury quoter mismatch");
        _true(treasury.isCanonicalFor(GACHA), "treasury graph is not canonical");

        IStockAdapter adapter = IStockAdapter(STOCK_ADAPTER);
        _eq(adapter.owner(), OWNER, "adapter owner mismatch");
        _eq(adapter.stockLock(), STOCK_LOCK, "adapter StockLock mismatch");
        _eq(adapter.weth(), WETH, "adapter WETH mismatch");
        _eq(adapter.router(), ROUTER, "adapter router mismatch");
        _eq(adapter.quoter(), QUOTER, "adapter quoter mismatch");

        _eq(gacha.BPS(), 10_000, "BPS mismatch");
        _eq(gacha.PACK_COUNT(), 3, "pack count mismatch");
        _eq(gacha.packPrice(0), 5e6, "pack zero price mismatch");
        _eq(gacha.packPrice(1), 10e6, "pack one price mismatch");
        _eq(gacha.packPrice(2), 20e6, "pack two price mismatch");
        _eq(gacha.USD_UNIT(), 1e6, "USDC unit mismatch");
        _eq(gacha.RESOLVE_WINDOW(), 1 days, "resolve window mismatch");
        _eq(gacha.TARGET_RTP_BPS(), 8_500, "target RTP mismatch");
        _eq(gacha.HOUSE_EDGE_BPS(), 1_500, "house edge mismatch");
        _eq(gacha.MIN_CEILING_BPS(), 20_000, "minimum ceiling mismatch");
        _eq(gacha.multiplierBpsFor(59_999), 2_500, "low-rung upper boundary mismatch");
        _eq(gacha.multiplierBpsFor(60_000), 5_000, "second-rung lower boundary mismatch");
        _eq(gacha.MIN_DISTRIBUTE(), 10e6, "minimum distribution mismatch");
        _eq(gacha.MAX_DISTRIBUTE(), 2_000e6, "maximum distribution mismatch");
        _eq(gacha.BOUNTY_BPS(), 100, "bounty split mismatch");
        _eq(gacha.RESERVE_BPS(), 5_000, "reserve split mismatch");
        _eq(gacha.STAKER_BPS(), 5_000, "staker split mismatch");
        _eq(treasury.MIN_DISTRIBUTE(), gacha.MIN_DISTRIBUTE(), "peer minimum distribution mismatch");
        _eq(treasury.MAX_DISTRIBUTE(), gacha.MAX_DISTRIBUTE(), "peer maximum distribution mismatch");
        _eq(treasury.BOUNTY_BPS(), gacha.BOUNTY_BPS(), "peer bounty split mismatch");
        _eq(treasury.RESERVE_BPS(), gacha.RESERVE_BPS(), "peer reserve split mismatch");
        _eq(treasury.STAKER_BPS(), gacha.STAKER_BPS(), "peer staker split mismatch");

        _true(usdc.balanceOf(GACHA) >= gacha.protectedUsdc(), "buyer liabilities are undercollateralized");
        _true(gacha.freeReserveUsdc() > 0, "pinned reserve has no free cash");
        _true(gacha.entropyFee() > 0, "pinned Entropy fee is zero");

        (uint256 ceiling, address[] memory tokens, bytes32[] memory routeHashes) = gacha.eligibleOffer(2);
        _true(ceiling >= gacha.MIN_CEILING_BPS(), "pack has no covered ceiling");
        _eq(tokens.length, routeHashes.length, "offer arrays differ");
        _true(tokens.length > 0, "offer has no stock");
        for (uint256 i; i < tokens.length; ++i) {
            _true(tokens[i] != address(0), "offer contains zero token");
            _true(routeHashes[i] != bytes32(0), "offer contains zero route hash");
            _eq(treasury.payoutToken(routeHashes[i]), tokens[i], "cached route token mismatch");
        }
    }

    function testBankrWalletFullLifecycleExpiryReserveFundingAndProfitDistribution() public {
        BankrWalletHarness wallet = new BankrWalletHarness();
        vm.deal(address(wallet), 1 ether);
        _setTokenBalance(USDC, address(wallet), 100e6);

        uint256 initialWalletUsdc = usdc.balanceOf(address(wallet));
        uint256 initialGachaUsdc = usdc.balanceOf(GACHA);
        uint256 initialDistributable = gacha.distributableProfitUsdc();

        // Exact approval and exact native Pyth fee are distinct legs of one open-pack plan.
        uint256 requestId = _openThroughWallet(wallet, 2, bytes32(uint256(0xB4A6_0001)));
        _eq(usdc.allowance(address(wallet), GACHA), 0, "pack approval was not fully consumed");
        _eq(usdc.balanceOf(address(wallet)), initialWalletUsdc - 20e6, "wrong pack charge");
        _eq(usdc.balanceOf(GACHA), initialGachaUsdc + 20e6, "gacha did not receive exact pack charge");

        (address buyer, uint96 paidUsdc,,,,, uint8 pendingStatus,,,) = gacha.requests(requestId);
        _eq(buyer, address(wallet), "request buyer is not smart wallet");
        _eq(uint256(paidUsdc), 20e6, "request paid amount mismatch");
        _eq(uint256(pendingStatus), 1, "request is not Pending");

        // Spoof only the immutable authenticated Entropy caller on the local fork. The provider
        // and random word still pass through production callback logic and pinned request data.
        bytes32 providerRandom = _lowRungRandom();
        vm.prank(ENTROPY);
        // Entropy v2 assigns a uint64 sequence; StonkGacha only widens it for request storage/API use.
        // forge-lint: disable-next-line(unsafe-typecast)
        gacha._entropyCallback(uint64(requestId), ENTROPY_PROVIDER, providerRandom);

        (,,,, uint32 pinnedCeiling,, uint8 readyStatus, address wonToken,, uint256 storedWord) =
            gacha.requests(requestId);
        (, uint96 payoutUsdc) = gacha.requestFunding(requestId);
        (bytes32 routeHash, uint256 beforeRecordedOut) = gacha.requestDelivery(requestId);
        _eq(uint256(readyStatus), 2, "callback did not produce Ready state");
        _eq(uint256(payoutUsdc), 5e6, "low rung did not reserve a quarter-pack payout");
        _true(pinnedCeiling >= 20_000, "pinned ceiling fell below minimum");
        _true(wonToken != address(0), "callback selected zero token");
        _true(routeHash != bytes32(0), "callback selected zero route");
        _eq(beforeRecordedOut, 0, "Ready request already records delivery");
        _eq(storedWord, uint256(providerRandom), "callback random word mismatch");
        _eq(treasury.payoutToken(routeHash), wonToken, "pinned route resolves to wrong token");

        uint256 quotedStock = treasury.quotePayout(routeHash, payoutUsdc);
        _true(quotedStock > 0, "historical payout route does not quote");
        uint256 minStockOut = quotedStock * 97 / 100;
        _true(minStockOut > 0, "claim floor is zero");
        uint256 stockBefore = IERC20Minimal(wonToken).balanceOf(address(wallet));
        bytes memory deliveredResult = wallet.execute(
            GACHA, 0, abi.encodeCall(IStonkGacha.claimPrize, (requestId, minStockOut, block.timestamp + 10 minutes))
        );
        uint256 delivered = abi.decode(deliveredResult, (uint256));
        _true(delivered >= minStockOut, "delivered stock missed floor");
        _eq(IERC20Minimal(wonToken).balanceOf(address(wallet)) - stockBefore, delivered, "wallet stock delta mismatch");
        (,,,,,, uint8 deliveredStatus,, uint256 recordedOut,) = gacha.requests(requestId);
        _eq(uint256(deliveredStatus), 5, "claim did not produce Delivered state");
        _eq(recordedOut, delivered, "request did not record exact stock output");

        // The 20 USDC charge and 5 USDC Ready budget add 15 USDC of realized net profit.
        uint256 nowDistributable = gacha.distributableProfitUsdc();
        _true(nowDistributable >= initialDistributable + 15e6, "resolved low rung did not create expected profit");
        uint256 distributeAmount = 10e6;
        uint256 quotedWeth = treasury.quoteProfit(distributeAmount);
        uint256 minWethOut = quotedWeth * 97 / 100;
        _true(minWethOut > 0, "profit distribution floor is zero");
        uint256 processedBefore = gacha.cumulativeProcessedProfitUsdc();
        uint256 workerUsdcBefore = usdc.balanceOf(address(wallet));
        vm.roll(block.number + 1);
        bytes memory profitResult = wallet.execute(
            GACHA,
            0,
            abi.encodeCall(IStonkGacha.distributeProfit, (distributeAmount, minWethOut, block.timestamp + 5 minutes))
        );
        (uint256 bountyUsdc, uint256 retainedUsdc, uint256 stakerUsdc, uint256 wethToStakers) =
            abi.decode(profitResult, (uint256, uint256, uint256, uint256));
        _eq(bountyUsdc, 100_000, "worker bounty is not one percent");
        _eq(retainedUsdc + stakerUsdc + bountyUsdc, distributeAmount, "profit split does not conserve input");
        _true(wethToStakers >= minWethOut, "staker WETH missed floor");
        _eq(
            gacha.cumulativeProcessedProfitUsdc(),
            processedBefore + distributeAmount,
            "processed profit did not advance"
        );
        _eq(usdc.balanceOf(address(wallet)), workerUsdcBefore + bountyUsdc, "smart wallet did not receive bounty");

        // Reserve funding is a separate exact-allowance donation and never enters revenue.
        uint256 fundedBefore = gacha.cumulativeFundedReserveUsdc();
        uint256 revenueBeforeFunding = _cumulativeRevenue();
        _approveThroughWallet(wallet, 1e6);
        wallet.execute(GACHA, 0, abi.encodeCall(IStonkGacha.fundReserve, (1e6)));
        _eq(gacha.cumulativeFundedReserveUsdc(), fundedBefore + 1e6, "funded reserve counter mismatch");
        _eq(_cumulativeRevenue(), revenueBeforeFunding, "reserve funding was booked as revenue");
        _eq(usdc.allowance(address(wallet), GACHA), 0, "reserve funding approval was not consumed");

        // A second request proves permissionless expiry and buyer-only pull refund.
        uint256 refundRequestId = _openThroughWallet(wallet, 0, bytes32(uint256(0xB4A6_0002)));
        (,, uint64 openedAt,,,, uint8 secondPendingStatus,,,) = gacha.requests(refundRequestId);
        _eq(uint256(secondPendingStatus), 1, "refund fixture is not Pending");
        uint256 balanceBeforeRefund = usdc.balanceOf(address(wallet));
        vm.warp(uint256(openedAt) + gacha.RESOLVE_WINDOW());
        gacha.expireRequest(refundRequestId);
        _eq(gacha.refundClaimable(refundRequestId), 5e6, "expired request has wrong refund credit");
        wallet.execute(GACHA, 0, abi.encodeCall(IStonkGacha.claimRefund, (refundRequestId)));
        _eq(usdc.balanceOf(address(wallet)), balanceBeforeRefund + 5e6, "full pack refund did not reach wallet");
        (,,,,,, uint8 refundedStatus,,,) = gacha.requests(refundRequestId);
        _eq(uint256(refundedStatus), 4, "refund did not produce Refunded state");
    }

    function _openThroughWallet(BankrWalletHarness wallet, uint256 packIndex, bytes32 userRandom)
        private
        returns (uint256 requestId)
    {
        uint256 packPrice = gacha.packPrice(packIndex);
        (uint256 ceiling, address[] memory tokens, bytes32[] memory routes) = gacha.eligibleOffer(packIndex);
        _true(tokens.length > 0 && tokens.length == routes.length, "offer unavailable");
        bytes32 expectedHash = keccak256(abi.encode(packIndex, ceiling, tokens, routes));
        _eq(expectedHash, gacha.offerHash(packIndex), "local offer commitment mismatch");
        _approveThroughWallet(wallet, packPrice);
        uint256 fee = gacha.entropyFee();
        bytes memory result = wallet.execute{value: fee}(
            GACHA, fee, abi.encodeCall(IStonkGacha.openPack, (packIndex, ceiling, expectedHash, userRandom))
        );
        requestId = abi.decode(result, (uint256));
    }

    function _approveThroughWallet(BankrWalletHarness wallet, uint256 amount) private {
        _eq(usdc.allowance(address(wallet), GACHA), 0, "unexpected starting allowance");
        bytes memory result = wallet.execute(USDC, 0, abi.encodeCall(IERC20Minimal.approve, (GACHA, amount)));
        _true(abi.decode(result, (bool)), "USDC approve returned false");
        _eq(usdc.allowance(address(wallet), GACHA), amount, "approval is not exact");
    }

    function _lowRungRandom() private pure returns (bytes32 randomNumber) {
        for (uint256 candidate = 1; candidate < 10_000; ++candidate) {
            uint256 roll = uint256(keccak256(abi.encode(candidate, uint256(0)))) % 1_000_000;
            if (roll < 60_000) return bytes32(candidate);
        }
        revert AssertionFailed("no low-rung random found");
    }

    /// @dev USDC is a proxy, so this finds the balance mapping without importing forge-std's
    /// storage-discovery helpers. Every failed probe is restored before trying the next slot.
    function _setTokenBalance(address token, address account, uint256 amount) private {
        for (uint256 mappingSlot; mappingSlot < 64; ++mappingSlot) {
            bytes32 slot = keccak256(abi.encode(account, mappingSlot));
            bytes32 previous = vm.load(token, slot);
            vm.store(token, slot, bytes32(amount));
            if (IERC20Minimal(token).balanceOf(account) == amount) return;
            vm.store(token, slot, previous);
        }
        revert TokenBalanceSlotNotFound();
    }

    function _cumulativeRevenue() private view returns (uint256 value) {
        (bool ok, bytes memory data) = GACHA.staticcall(abi.encodeWithSignature("cumulativeRevenueUsdc()"));
        if (!ok || data.length != 32) revert AssertionFailed("revenue read failed");
        value = abi.decode(data, (uint256));
    }

    function _true(bool condition, string memory reason) private pure {
        if (!condition) revert AssertionFailed(reason);
    }

    function _false(bool condition, string memory reason) private pure {
        if (condition) revert AssertionFailed(reason);
    }

    function _eq(uint256 actual, uint256 expected, string memory reason) private pure {
        if (actual != expected) revert AssertionFailed(reason);
    }

    function _eq(address actual, address expected, string memory reason) private pure {
        if (actual != expected) revert AssertionFailed(reason);
    }

    function _eq(bytes32 actual, bytes32 expected, string memory reason) private pure {
        if (actual != expected) revert AssertionFailed(reason);
    }
}
