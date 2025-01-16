import chai, { assert, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ethers } from 'hardhat';
import { MerkleTree } from 'merkletreejs';
import { ERC721M } from '../../typechain-types';
import { Signer } from 'ethers';

const { keccak256, getAddress } = ethers;
const MINT_FEE_RECEIVER = '0x0B98151bEdeE73f9Ba5F2C7b72dEa02D38Ce49Fc';

chai.use(chaiAsPromised);

describe('ERC721M', function () {
  let contract: ERC721M;
  let readonlyContract: ERC721M;
  let owner: Signer;
  let fundReceiver: Signer;
  let readonly: Signer;
  let chainId: BigInt;

  const getCosignSignature = async (
    contractInstance: ERC721M,
    cosigner: Signer,
    minter: string,
    timestamp: number,
    qty: number,
    waiveMintFee: boolean,
  ) => {
    const nonce = await contractInstance.getCosignNonce(minter);
    const digestFromJs = ethers.solidityPackedKeccak256(
      [
        'address',
        'address',
        'uint32',
        'bool',
        'address',
        'uint256',
        'uint256',
        'uint256',
      ],
      [
        await contractInstance.getAddress(),
        minter,
        qty,
        waiveMintFee,
        await cosigner.getAddress(),
        timestamp,
        chainId,
        nonce,
      ],
    );
    return await cosigner.signMessage(ethers.getBytes(digestFromJs));
  };

  beforeEach(async () => {
    [owner, readonly, fundReceiver] = await ethers.getSigners();

    const ERC721M = await ethers.getContractFactory('ERC721M');
    const erc721M = await ERC721M.deploy(
      'Test',
      'TEST',
      '',
      1000,
      0,
      ethers.ZeroAddress,
      60,
      ethers.ZeroAddress,
      fundReceiver.getAddress(),
    );
    await erc721M.waitForDeployment();

    contract = erc721M.connect(owner);
    readonlyContract = erc721M.connect(readonly);
    chainId = await ethers.provider.getNetwork().then((n) => n.chainId);
  });

  it('Contract can be paused/unpaused', async () => {
    // starts unpaused
    expect(await contract.getMintable()).to.be.true;

    await contract.setMintable(false);
    expect(await contract.getMintable()).to.be.false;

    // unpause
    await contract.setMintable(true);
    expect(await contract.getMintable()).to.be.true;

    // we should assert that the correct event is emitted
    await expect(contract.setMintable(false))
      .to.emit(contract, 'SetMintable')
      .withArgs(false);
    expect(await contract.getMintable()).to.be.false;

    // readonlyContract should not be able to setMintable
    await expect(readonlyContract.setMintable(true)).to.be.revertedWithCustomError(readonlyContract, 
      'Unauthorized',
    );
  });

  it('withdraws balance by owner', async () => {
    // Send 100 wei to contract address for testing.
    await ethers.provider.send('hardhat_setBalance', [
      await contract.getAddress(),
      '0x64', // 100 wei
    ]);
    expect(
      await ethers.provider.getBalance(await contract.getAddress()),
    ).to.equal(100n);

    await expect(() => contract.withdraw()).to.changeEtherBalances(
      [contract, owner, fundReceiver],
      [-100, 0, 100],
    );

    expect(
      await ethers.provider.getBalance(await contract.getAddress()),
    ).to.equal(0n);

    // readonlyContract should not be able to withdraw
    await expect(readonlyContract.withdraw()).to.be.revertedWithCustomError(readonlyContract, 
      'Unauthorized',
    );
  });

  describe('Stages', function () {
    it('cannot set stages with readonly address', async () => {
      await expect(
        readonlyContract.setStages([
          {
            price: ethers.parseEther('0.5'),
            mintFee: ethers.parseEther('0.01'),
            walletLimit: 3,
            merkleRoot: ethers.zeroPadValue('0x10', 32),
            maxStageSupply: 5,
            startTimeUnixSeconds: 0,
            endTimeUnixSeconds: 1,
          },
          {
            price: ethers.parseEther('0.6'),
            mintFee: ethers.parseEther('0.01'),
            walletLimit: 4,
            merkleRoot: ethers.zeroPadValue('0x20', 32),
            maxStageSupply: 10,
            startTimeUnixSeconds: 61,
            endTimeUnixSeconds: 62,
          },
        ]),
      ).to.be.revertedWithCustomError(readonlyContract, 'Unauthorized');
    });

    it('cannot set stages with insufficient gap', async () => {
      await expect(
        contract.setStages([
          {
            price: ethers.parseEther('0.5'),
            mintFee: ethers.parseEther('0'),
            walletLimit: 3,
            merkleRoot: ethers.zeroPadValue('0x10', 32),
            maxStageSupply: 5,
            startTimeUnixSeconds: 0,
            endTimeUnixSeconds: 1,
          },
          {
            price: ethers.parseEther('0.6'),
            mintFee: ethers.parseEther('0'),
            walletLimit: 4,
            merkleRoot: ethers.zeroPadValue('0x20', 32),
            maxStageSupply: 10,
            startTimeUnixSeconds: 60,
            endTimeUnixSeconds: 62,
          },
        ]),
      ).to.be.revertedWithCustomError(contract, 'InsufficientStageTimeGap');
    });

    it('cannot set stages due to startTimeUnixSeconds is not smaller than endTimeUnixSeconds', async () => {
      await expect(
        contract.setStages([
          {
            price: ethers.parseEther('0.5'),
            mintFee: ethers.parseEther('0'),
            walletLimit: 3,
            merkleRoot: ethers.zeroPadValue('0x10', 32),
            maxStageSupply: 5,
            startTimeUnixSeconds: 0,
            endTimeUnixSeconds: 0,
          },
          {
            price: ethers.parseEther('0.6'),
            mintFee: ethers.parseEther('0'),
            walletLimit: 4,
            merkleRoot: ethers.zeroPadValue('0x20', 32),
            maxStageSupply: 10,
            startTimeUnixSeconds: 61,
            endTimeUnixSeconds: 61,
          },
        ]),
      ).to.be.revertedWithCustomError(contract, 'InvalidStartAndEndTimestamp');

      await expect(
        contract.setStages([
          {
            price: ethers.parseEther('0.5'),
            mintFee: ethers.parseEther('0'),
            walletLimit: 3,
            merkleRoot: ethers.zeroPadValue('0x10', 32),
            maxStageSupply: 5,
            startTimeUnixSeconds: 1,
            endTimeUnixSeconds: 0,
          },
          {
            price: ethers.parseEther('0.6'),
            mintFee: ethers.parseEther('0'),
            walletLimit: 4,
            merkleRoot: ethers.zeroPadValue('0x20', 32),
            maxStageSupply: 10,
            startTimeUnixSeconds: 62,
            endTimeUnixSeconds: 61,
          },
        ]),
      ).to.be.revertedWithCustomError(contract, 'InvalidStartAndEndTimestamp');
    });

    it('can set / reset stages', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.01'),
          walletLimit: 3,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.01'),
          walletLimit: 4,
          merkleRoot: ethers.zeroPadValue('0x20', 32),
          maxStageSupply: 10,
          startTimeUnixSeconds: 61,
          endTimeUnixSeconds: 62,
        },
      ]);

      expect(await contract.getNumberStages()).to.equal(2);

      let [stageInfo, walletMintedCount] = await contract.getStageInfo(0);
      expect(stageInfo.price).to.equal(ethers.parseEther('0.5'));
      expect(stageInfo.walletLimit).to.equal(3);
      expect(stageInfo.maxStageSupply).to.equal(5);
      expect(stageInfo.merkleRoot).to.equal(ethers.zeroPadValue('0x10', 32));
      expect(walletMintedCount).to.equal(0);

      [stageInfo, walletMintedCount] = await contract.getStageInfo(1);
      expect(stageInfo.price).to.equal(ethers.parseEther('0.6'));
      expect(stageInfo.walletLimit).to.equal(4);
      expect(stageInfo.maxStageSupply).to.equal(10);
      expect(stageInfo.merkleRoot).to.equal(ethers.zeroPadValue('0x20', 32));
      expect(walletMintedCount).to.equal(0);

      // Update to one stage
      await contract.setStages([
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.06'),
          walletLimit: 4,
          merkleRoot: ethers.zeroPadValue('0x30', 32),
          maxStageSupply: 0,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);

      expect(await contract.getNumberStages()).to.equal(1);
      [stageInfo, walletMintedCount] = await contract.getStageInfo(0);
      expect(stageInfo.price).to.equal(ethers.parseEther('0.6'));
      expect(stageInfo.walletLimit).to.equal(4);
      expect(stageInfo.maxStageSupply).to.equal(0);
      expect(stageInfo.merkleRoot).to.equal(ethers.zeroPadValue('0x30', 32));
      expect(walletMintedCount).to.equal(0);

      // Add another stage
      await contract.setStages([
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.06'),
          walletLimit: 4,
          merkleRoot: ethers.zeroPadValue('0x30', 32),
          maxStageSupply: 0,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
        {
          price: ethers.parseEther('0.7'),
          mintFee: ethers.parseEther('0.07'),
          walletLimit: 5,
          merkleRoot: ethers.zeroPadValue('0x40', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 61,
          endTimeUnixSeconds: 62,
        },
      ]);
      expect(await contract.getNumberStages()).to.equal(2);
      [stageInfo, walletMintedCount] = await contract.getStageInfo(1);
      expect(stageInfo.price).to.equal(ethers.parseEther('0.7'));
      expect(stageInfo.walletLimit).to.equal(5);
      expect(stageInfo.maxStageSupply).to.equal(5);
      expect(stageInfo.merkleRoot).to.equal(ethers.zeroPadValue('0x40', 32));
      expect(walletMintedCount).to.equal(0);
    });

    it('gets stage info', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 3,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);

      expect(await contract.getNumberStages()).to.equal(1);

      const [stageInfo, walletMintedCount] = await contract.getStageInfo(0);
      expect(stageInfo.price).to.equal(ethers.parseEther('0.5'));
      expect(stageInfo.walletLimit).to.equal(3);
      expect(stageInfo.maxStageSupply).to.equal(5);
      expect(stageInfo.merkleRoot).to.equal(ethers.zeroPadValue('0x10', 32));
      expect(walletMintedCount).to.equal(0);
    });

    it('gets stage info reverts for non-existent stage', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 3,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);

      const getStageInfo = readonlyContract.getStageInfo(1);
      await expect(getStageInfo).to.be.revertedWith('InvalidStage');
    });

    it('can find active stage', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 3,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.06'),
          walletLimit: 4,
          merkleRoot: ethers.zeroPadValue('0x20', 32),
          maxStageSupply: 10,
          startTimeUnixSeconds: 61,
          endTimeUnixSeconds: 62,
        },
      ]);

      expect(await contract.getNumberStages()).to.equal(2);
      expect(await contract.getActiveStageFromTimestamp(0)).to.equal(0);

      expect(await contract.getActiveStageFromTimestamp(61)).to.equal(1);

      const setActiveStage = contract.getActiveStageFromTimestamp(70);
      await expect(setActiveStage).to.be.revertedWithCustomError(contract, 'InvalidStage');
    });
  });

  describe('Minting', function () {
    it('revert if contract is not mintable', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);
      await contract.setMintable(false);

      // not mintable by owner
      let mint = contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.1'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'NotMintable');

      // not mintable by readonly address
      mint = readonlyContract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.1'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(readonlyContract, 'NotMintable');
    });

    it('revert if contract without stages', async () => {
      const mint = contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.5'),
        },
      );

      await expect(mint).to.be.revertedWithCustomError(contract, 'InvalidStage');
    });

    it('revert if incorrect (less) amount sent', async () => {
      // Get an estimated stage start time
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.4'),
          mintFee: ethers.parseEther('0.1'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 2,
        },
      ]);

      // Setup the test context: block.timestamp should comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      let mint;
      mint = contract.mint(
        5,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('2.499'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'NotEnoughValue');

      mint = contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.499999'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'NotEnoughValue');
    });

    it('revert on reentrancy', async () => {
      const reentrancyFactory = await ethers.getContractFactory(
        'TestReentrantExploit',
      );
      const reentrancyExploiter = await reentrancyFactory.deploy(
        contract.getAddress(),
      );
      await reentrancyExploiter.waitForDeployment();

      // Get an estimated timestamp for the stage start
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.1'),
          mintFee: ethers.parseEther('0.01'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 0,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 100000,
        },
      ]);

      // Setup the test context: block.timestamp should comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      await expect(
        reentrancyExploiter.exploit(1, [], stageStart, '0x', {
          value: ethers.parseEther('0.2'),
        }),
      ).to.be.revertedWithCustomError(contract, 'Reentrancy');
    });

    it('can set max mintable supply', async () => {
      await contract.setMaxMintableSupply(99);
      expect(await contract.getMaxMintableSupply()).to.equal(99);

      // can set the mintable supply again with the same value
      await contract.setMaxMintableSupply(99);
      expect(await contract.getMaxMintableSupply()).to.equal(99);

      // can set the mintable supply again with the lower value
      await contract.setMaxMintableSupply(98);
      expect(await contract.getMaxMintableSupply()).to.equal(98);

      // can not set the mintable supply with higher value
      await expect(contract.setMaxMintableSupply(100)).to.be.rejectedWith(
        'CannotIncreaseMaxMintableSupply',
      );

      // readonlyContract should not be able to set max mintable supply
      await expect(
        readonlyContract.setMaxMintableSupply(99),
      ).to.be.revertedWithCustomError(readonlyContract, 'Unauthorized');
    });

    it('enforces max mintable supply', async () => {
      await contract.setMaxMintableSupply(99);
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.06'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x20', 32),
          maxStageSupply: 10,
          startTimeUnixSeconds: 61,
          endTimeUnixSeconds: 62,
        },
      ]);

      // Mint 100 tokens (1 over MaxMintableSupply)
      const mint = contract.mint(
        100,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('2.5'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'NoSupplyLeft');
    });

    it('mint with wallet limit', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 100,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 0,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 2,
        },
      ]);
      await contract.setMaxMintableSupply(999);

      // Setup the test context: block.timestamp should comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      // Mint 100 tokens - wallet limit
      await contract.mint(
        100,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('50'),
        },
      );

      // Mint one more should fail
      const mint = contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.5'),
        },
      );

      await expect(mint).to.be.revertedWithCustomError(contract, 'WalletStageLimitExceeded');
    });

    it('mint with limited stage supply', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.05'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 2,
        },
      ]);
      await contract.setMaxMintableSupply(999);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      // Mint 100 tokens - stage limit
      await contract.mint(
        100,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('5'),
        },
      );

      // Mint one more should fail
      const mint = contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.5'),
        },
      );

      await expect(mint).to.be.revertedWithCustomError(contract, 'StageSupplyExceeded');
    });

    it('mint with free stage', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0'),
          mintFee: 0,
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1,
        },
      ]);

      const contractBalanceInitial = await ethers.provider.getBalance(
        await contract.getAddress(),
      );
      const mintFeeReceiverBalanceInitial =
        await ethers.provider.getBalance(MINT_FEE_RECEIVER);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      await readonlyContract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0'),
        },
      );
      const [stageInfo, walletMintedCount, stagedMintedCount] =
        await readonlyContract.getStageInfo(0);
      expect(stageInfo.maxStageSupply).to.equal(100);
      expect(walletMintedCount).to.equal(1);
      expect(stagedMintedCount).to.equal(1n);

      const contractBalancePost = await ethers.provider.getBalance(
        await contract.getAddress(),
      );
      expect(contractBalancePost - contractBalanceInitial).to.equal(0n);

      const mintFeeReceiverBalancePost =
        await ethers.provider.getBalance(MINT_FEE_RECEIVER);
      expect(
        mintFeeReceiverBalancePost - mintFeeReceiverBalanceInitial,
      ).to.equal(0n);
    });

    it('mint with free stage with mint fee', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0'),
          mintFee: ethers.parseEther('0.1'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1,
        },
      ]);

      const contractBalanceInitial = await ethers.provider.getBalance(
        await contract.getAddress(),
      );
      const mintFeeReceiverBalanceInitial =
        await ethers.provider.getBalance(MINT_FEE_RECEIVER);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      await readonlyContract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.1'),
        },
      );

      await contract.withdraw();

      const [stageInfo, walletMintedCount, stagedMintedCount] =
        await readonlyContract.getStageInfo(0);
      expect(stageInfo.maxStageSupply).to.equal(100);
      expect(walletMintedCount).to.equal(1);
      expect(stagedMintedCount).to.equal(1n);

      const contractBalancePost = await ethers.provider.getBalance(
        await contract.getAddress(),
      );
      expect(contractBalancePost - contractBalanceInitial).to.equal(0n);

      const mintFeeReceiverBalancePost =
        await ethers.provider.getBalance(MINT_FEE_RECEIVER);
      expect(
        mintFeeReceiverBalancePost - mintFeeReceiverBalanceInitial,
      ).to.equal(ethers.parseEther('0.1'));
    });

    it('mint with waived mint fee', async () => {
      const [_owner, minter, cosigner] = await ethers.getSigners();
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      const stageStart = block.timestamp;

      await contract.setStages([
        {
          price: 0,
          mintFee: ethers.parseEther('0.1'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1000,
        },
      ]);
      await contract.setMintable(true);
      await contract.setCosigner(cosigner.getAddress());

      const timestamp = stageStart + 100;
      let sig = getCosignSignature(
        contract,
        cosigner,
        await minter.getAddress(),
        timestamp,
        1,
        false,
      );
      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          sig,
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'NotEnoughValue');

      sig = getCosignSignature(
        contract,
        cosigner,
        await minter.getAddress(),
        timestamp,
        1,
        true,
      );
      await readonlyContract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        timestamp,
        sig,
        {
          value: ethers.parseEther('0'),
        },
      );
      const [stageInfo, walletMintedCount, stagedMintedCount] =
        await readonlyContract.getStageInfo(0);
      expect(stageInfo.maxStageSupply).to.equal(100);
      expect(walletMintedCount).to.equal(1);
      expect(stagedMintedCount).to.equal(1n);
    });

    it('mint with cosign - happy path', async () => {
      const [_owner, minter, cosigner] = await ethers.getSigners();
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      const stageStart = block.timestamp;

      await contract.setStages([
        {
          price: ethers.parseEther('0'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1000,
        },
      ]);
      await contract.setCosigner(cosigner.getAddress());

      const timestamp = stageStart + 200;
      const sig = getCosignSignature(
        contract,
        cosigner,
        await minter.getAddress(),
        timestamp,
        1,
        false,
      );
      await readonlyContract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        timestamp,
        sig,
        {
          value: ethers.parseEther('0'),
        },
      );
      const [stageInfo, walletMintedCount, stagedMintedCount] =
        await readonlyContract.getStageInfo(0);
      expect(stageInfo.maxStageSupply).to.equal(100);
      expect(walletMintedCount).to.equal(1);
      expect(stagedMintedCount).to.equal(1n);
    });

    it('mint with cosign - invalid sigs', async () => {
      const [_owner, minter, cosigner] = await ethers.getSigners();
      await contract.setStages([
        {
          price: ethers.parseEther('0'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);
      await contract.setCosigner(cosigner.getAddress());

      const timestamp = Math.floor(new Date().getTime() / 1000);
      const sig = await getCosignSignature(
        contract,
        cosigner,
        await minter.getAddress(),
        timestamp,
        1,
        false,
      );

      // invalid because of unexpected timestamp
      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp + 1,
          sig,
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'InvalidCosignSignature');

      // invalid because of unexptected sig
      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          sig + '00',
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'InvalidCosignSignature');
      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          '0x00',
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'InvalidCosignSignature');
      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          '0',
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.rejectedWith(/^invalid BytesLike value/);
      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          '',
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.rejectedWith(/^invalid BytesLike value/);

      // invalid because of unawait expected minter
      await expect(
        contract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          sig,
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(contract, 'InvalidCosignSignature');
    });

    it('mint with cosign - timestamp out of stage', async () => {
      const [_owner, minter, cosigner] = await ethers.getSigners();
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      const stageStart = block.timestamp;
      await contract.setStages([
        {
          price: ethers.parseEther('0'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1000,
        },
      ]);
      await contract.setCosigner(cosigner.getAddress());

      const earlyTimestamp = stageStart - 1;
      let sig = getCosignSignature(
        readonlyContract,
        cosigner,
        await minter.getAddress(),
        earlyTimestamp,
        1,
        false,
      );

      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          earlyTimestamp,
          sig,
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'InvalidStage');

      const lateTimestamp = stageStart + 1001;
      sig = getCosignSignature(
        readonlyContract,
        cosigner,
        await minter.getAddress(),
        lateTimestamp,
        1,
        false,
      );

      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          lateTimestamp,
          sig,
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'InvalidStage');
    });

    it('mint with cosign - expired signature', async () => {
      const [_owner, minter, cosigner] = await ethers.getSigners();
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      const stageStart = block.timestamp;
      await contract.setStages([
        {
          price: ethers.parseEther('0'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1000,
        },
      ]);
      await contract.setCosigner(cosigner.getAddress());

      const timestamp = stageStart;
      const sig = getCosignSignature(
        readonlyContract,
        cosigner,
        await minter.getAddress(),
        timestamp,
        1,
        false,
      );

      // fast forward 2 minutes
      await ethers.provider.send('evm_increaseTime', [120]);
      await ethers.provider.send('evm_mine', []);

      await expect(
        readonlyContract.mint(
          1,
          0,
          [ethers.zeroPadValue('0x00', 32)],
          timestamp,
          sig,
          {
            value: ethers.parseEther('0'),
          },
        ),
      ).to.be.revertedWithCustomError(readonlyContract, 'TimestampExpired');
    });

    it('enforces stage supply', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 3,
        },
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 10,
          startTimeUnixSeconds: stageStart + 63,
          endTimeUnixSeconds: stageStart + 66,
        },
      ]);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      // Mint 5 tokens
      await expect(
        contract.mint(5, 0, [ethers.zeroPadValue('0x00', 32)], 0, '0x00', {
          value: ethers.parseEther('2.5'),
        }),
      ).to.emit(contract, 'Transfer');

      let [stageInfo, walletMintedCount, stagedMintedCount] =
        await contract.getStageInfo(0);

      expect(stageInfo.maxStageSupply).to.equal(5);
      expect(walletMintedCount).to.equal(5);
      expect(stagedMintedCount).to.equal(5n);

      // Mint another 1 should fail since the stage limit has been reached.
      let mint = contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.5'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'StageSupplyExceeded');

      // Mint another 5 should fail since the stage limit has been reached.
      mint = contract.mint(
        5,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('2.5'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'StageSupplyExceeded');

      // Setup the test context: Update the block.timestamp to activate the 2nd stage
      await ethers.provider.send('evm_mine', [stageStart + 62]);

      await contract.mint(
        8,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('4.8'),
        },
      );
      [stageInfo, walletMintedCount, stagedMintedCount] =
        await contract.getStageInfo(1);
      expect(stageInfo.maxStageSupply).to.equal(10);
      expect(walletMintedCount).to.equal(8);
      expect(stagedMintedCount).to.equal(8n);

      await assert.isRejected(
        contract.mint(3, 0, [ethers.zeroPadValue('0x00', 32)], 0, '0x00', {
          value: ethers.parseEther('1.8'),
        }),
        /StageSupplyExceeded/,
        "Minting more than the stage's supply should fail",
      );

      await contract.mint(
        2,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('1.2'),
        },
      );

      [stageInfo, walletMintedCount, stagedMintedCount] =
        await contract.getStageInfo(1);
      expect(walletMintedCount).to.equal(10);
      expect(stagedMintedCount).to.equal(10n);

      [stageInfo, walletMintedCount, stagedMintedCount] =
        await contract.getStageInfo(0);
      expect(walletMintedCount).to.equal(5);
      expect(stagedMintedCount).to.equal(5n);

      const [address] = await ethers.getSigners();
      const totalMinted = await contract.totalMintedByAddress(
        await address.getAddress(),
      );
      expect(totalMinted).to.equal(15n);
    });

    it('enforces Merkle proof if required', async () => {
      const accounts = await Promise.all((await ethers.getSigners()).map(async (signer) =>
        getAddress(await signer.getAddress()).toLowerCase().trim(),
      ));
      const leaves = accounts.map((account) =>
        ethers.solidityPackedKeccak256(['address', 'uint32'], [account, 0]),
      );
      const signerAddress = await (await ethers.provider.getSigner()).getAddress();
      const merkleTree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
        hashLeaves: false,
      });
      const root = merkleTree.getHexRoot();

      const leaf = ethers.solidityPackedKeccak256(
        ['address', 'uint32'],
        [signerAddress.toLowerCase().trim(), 0],
      );
      const proof = merkleTree.getHexProof(leaf);

      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.1'),
          mintFee: 0,
          walletLimit: 10,
          merkleRoot: root,
          maxStageSupply: 5,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 3,
        },
      ]);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      // Mint 1 token with valid proof
      await contract.mint(1, 0, proof, 0, '0x00', {
        value: ethers.parseEther('0.1'),
      });
      const totalMinted = await contract.totalMintedByAddress(signerAddress);
      expect(totalMinted).to.equal(1n);

      // Mint 1 token with someone's else proof should be reverted
      await expect(
        readonlyContract.mint(1, 0, proof, 0, '0x00', {
          value: ethers.parseEther('0.1'),
        }),
      ).to.be.rejectedWith('InvalidProof');
    });

    it('reverts on invalid Merkle proof', async () => {
      const root = ethers.zeroPadValue('0x10', 32);
      const proof = [ethers.zeroPadValue('0x10', 32)];
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0'),
          walletLimit: 10,
          merkleRoot: root,
          maxStageSupply: 5,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1,
        },
      ]);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      // Mint 1 token with invalid proof
      const mint = contract.mint(1, 0, proof, 0, '0x00', {
        value: ethers.parseEther('0.5'),
      });
      await expect(mint).to.be.revertedWithCustomError(contract, 'InvalidProof');
    });

    it('mint with limit', async () => {
      const ownerAddress = await owner.getAddress();
      const readerAddress = await readonly.getAddress();
      const leaves = [
        ethers.solidityPackedKeccak256(
          ['address', 'uint32'],
          [ownerAddress, 2],
        ),
        ethers.solidityPackedKeccak256(
          ['address', 'uint32'],
          [readerAddress, 5],
        ),
      ];

      const merkleTree = new MerkleTree(leaves, ethers.keccak256, {
        sortPairs: true,
        hashLeaves: false,
      });
      const root = merkleTree.getHexRoot();
      const ownerLeaf = ethers.solidityPackedKeccak256(
        ['address', 'uint32'],
        [ownerAddress, 2],
      );
      const readerLeaf = ethers.solidityPackedKeccak256(
        ['address', 'uint32'],
        [readerAddress, 5],
      );
      const ownerProof = merkleTree.getHexProof(ownerLeaf);
      const readerProof = merkleTree.getHexProof(readerLeaf);

      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.1'),
          mintFee: 0,
          walletLimit: 10,
          merkleRoot: root,
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 100,
        },
      ]);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);

      // Owner mints 1 token with valid proof
      await contract.mint(1, 2, ownerProof, 0, '0x00', {
        value: ethers.parseEther('0.1'),
      });
      expect(
        await contract.totalMintedByAddress(owner.getAddress()),
      ).to.equal(1n);

      // Owner mints 1 token with wrong limit and should be reverted.
      await expect(
        contract.mint(1, 3, ownerProof, 0, '0x00', {
          value: ethers.parseEther('0.1'),
        }),
      ).to.be.rejectedWith('InvalidProof');

      // Owner mints 2 tokens with valid proof and reverts.
      await expect(
        contract.mint(2, 2, ownerProof, 0, '0x00', {
          value: ethers.parseEther('0.2'),
        }),
      ).to.be.rejectedWith('WalletStageLimitExceeded');

      // Owner mints 1 token with valid proof. Now owner reaches the limit.
      await contract.mint(1, 2, ownerProof, 0, '0x00', {
        value: ethers.parseEther('0.1'),
      });
      expect(
        await contract.totalMintedByAddress(owner.getAddress()),
      ).to.equal(2n);

      // Owner tries to mint more and reverts.
      await expect(
        contract.mint(1, 2, ownerProof, 0, '0x00', {
          value: ethers.parseEther('0.1'),
        }),
      ).to.be.rejectedWith('WalletStageLimitExceeded');

      // Reader mints 6 tokens with valid proof and reverts.
      await expect(
        readonlyContract.mint(6, 5, readerProof, 0, '0x00', {
          value: ethers.parseEther('0.6'),
        }),
      ).to.be.rejectedWith('WalletStageLimitExceeded');

      // Reader mints 5 tokens with valid proof.
      await readonlyContract.mint(5, 5, readerProof, 0, '0x00', {
        value: ethers.parseEther('0.5'),
      });

      // Reader mints 1 token with valid proof and reverts.
      await expect(
        readonlyContract.mint(1, 5, readerProof, 0, '0x00', {
          value: ethers.parseEther('0.1'),
        }),
      ).to.be.rejectedWith('WalletStageLimitExceeded');
    });

    it('mints by owner', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 1,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 1,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);

      const [owner, address1] = await ethers.getSigners();

      await contract.ownerMint(5, owner.getAddress());

      const [, walletMintedCount, stagedMintedCount] =
        await contract.getStageInfo(0);
      expect(walletMintedCount).to.equal(0);
      expect(stagedMintedCount).to.equal(0n);
      const ownerBalance = await contract.balanceOf(owner.getAddress());
      expect(ownerBalance).to.equal(5n);

      await contract.ownerMint(5, address1.getAddress());
      const [, address1Minted] = await readonlyContract.getStageInfo(0, {
        from: address1.getAddress(),
      });
      expect(address1Minted).to.equal(0);

      const address1Balance = await contract.balanceOf(address1.getAddress());
      expect(address1Balance).to.equal(5n);

      expect(await contract.totalSupply()).to.equal(10n);
    });

    it('mints by owner - invalid cases', async () => {
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 1,
          merkleRoot: ethers.zeroPadValue('0x10', 32),
          maxStageSupply: 1,
          startTimeUnixSeconds: 0,
          endTimeUnixSeconds: 1,
        },
      ]);
      await expect(
        contract.ownerMint(1001, readonly.getAddress()),
      ).to.be.revertedWithCustomError(contract, 'NoSupplyLeft');
    });
  });

  describe('Authorized minter minting', function () {
    let stageStart = 0;
    let stageEnd = 0;

    beforeEach(async () => {
      // Get an estimated stage start time
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      stageStart = block.timestamp;
      // +100 is a number bigger than the count of transactions needed for this test
      stageEnd = stageStart + 100;

      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: 0,
          walletLimit: 1,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 1,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageEnd,
        },
      ]);
    });

    it('revert if not authorized minter', async () => {
      const mint = contract.authorizedMint(
        1,
        '0xef59F379B48f2E92aBD94ADcBf714D170967925D',
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.5'),
        },
      );
      await expect(mint).to.be.revertedWithCustomError(contract, 'NotAuthorized');
    });

    it('authorized mint', async () => {
      const recipient = '0xef59F379B48f2E92aBD94ADcBf714D170967925D';
      const reservoirSigner = await ethers.getImpersonatedSigner(
        '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF',
      );
      const reservoirAddress = await reservoirSigner.getAddress();

      // Send some wei to impersonated account
      await ethers.provider.send('hardhat_setBalance', [
        reservoirAddress,
        '0xFFFFFFFFFFFFFFFF',
      ]);

      const reservoirConn = contract.connect(reservoirSigner);

      await expect(
        reservoirConn.authorizedMint(
          1,
          '0xef59F379B48f2E92aBD94ADcBf714D170967925D',
          0,
          [ethers.zeroPadValue('0x00', 32)],
          0,
          '0x00',
          {
            value: ethers.parseEther('1'),
          },
        ),
      ).to.be.revertedWithCustomError(contract, 'NotAuthorized');

      await contract.addAuthorizedMinter(reservoirAddress);

      await reservoirConn.authorizedMint(
        1,
        '0xef59F379B48f2E92aBD94ADcBf714D170967925D',
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('1'),
        },
      );

      const totalMinted = await contract.totalMintedByAddress(recipient);
      expect(totalMinted).to.eql(1n);

      await contract.removeAuthorizedMinter(reservoirAddress);
      await expect(
        reservoirConn.authorizedMint(
          1,
          '0xef59F379B48f2E92aBD94ADcBf714D170967925D',
          0,
          [ethers.zeroPadValue('0x00', 32)],
          0,
          '0x00',
          {
            value: ethers.parseEther('1'),
          },
        ),
      ).to.be.revertedWithCustomError(reservoirConn, 'NotAuthorized');
    });
  });

  describe('Token URI', function () {
    it('Reverts for nonexistent token', async () => {
      await expect(contract.tokenURI(0)).to.be.revertedWithCustomError(contract, 
        'URIQueryForNonexistentToken',
      );
    });

    it('Returns empty tokenURI on empty baseURI', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1,
        },
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.06'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 10,
          startTimeUnixSeconds: stageStart + 61,
          endTimeUnixSeconds: stageStart + 62,
        },
      ]);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      await contract.mint(
        2,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('2.5'),
        },
      );

      expect(await contract.tokenURI(0)).to.equal('');
      expect(await contract.tokenURI(1)).to.equal('');

      await expect(contract.tokenURI(2)).to.be.revertedWithCustomError(contract, 
        'URIQueryForNonexistentToken',
      );
    });

    it('Returns non-empty tokenURI on non-empty baseURI', async () => {
      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.5'),
          mintFee: ethers.parseEther('0.05'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 5,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1,
        },
        {
          price: ethers.parseEther('0.6'),
          mintFee: ethers.parseEther('0.06'),
          walletLimit: 10,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 10,
          startTimeUnixSeconds: stageStart + 61,
          endTimeUnixSeconds: stageStart + 62,
        },
      ]);

      await contract.setBaseURI('base_uri_');

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      await contract.mint(
        2,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('2.5'),
        },
      );

      expect(await contract.tokenURI(0)).to.equal('base_uri_0');
      expect(await contract.tokenURI(1)).to.equal('base_uri_1');

      await expect(contract.tokenURI(2)).to.be.revertedWithCustomError(contract, 
        'URIQueryForNonexistentToken',
      );
    });
  });

  describe('Global wallet limit', function () {
    it('validates global wallet limit in constructor', async () => {
      const ERC721M = await ethers.getContractFactory('ERC721M');
      await expect(
        ERC721M.deploy(
          'Test',
          'TEST',
          '',
          100,
          1001,
          ethers.ZeroAddress,
          60,
          ethers.ZeroAddress,
          fundReceiver.getAddress(),
        ),
      ).to.be.revertedWithCustomError(ERC721M, 'GlobalWalletLimitOverflow');
    });

    it('sets global wallet limit', async () => {
      await contract.setGlobalWalletLimit(2);
      expect(await contract.getGlobalWalletLimit()).to.equal(2n);

      await expect(contract.setGlobalWalletLimit(1001)).to.be.revertedWithCustomError(contract, 
        'GlobalWalletLimitOverflow',
      );
    });

    it('enforces global wallet limit', async () => {
      await contract.setGlobalWalletLimit(2);
      expect(await contract.getGlobalWalletLimit()).to.equal(2n);

      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.1'),
          mintFee: ethers.parseEther('0.01'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 100,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 2,
        },
      ]);

      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      await contract.mint(
        2,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.22'),
        },
      );

      await expect(
        contract.mint(1, 0, [ethers.zeroPadValue('0x00', 32)], 0, '0x00', {
          value: ethers.parseEther('0.11'),
        }),
      ).to.be.revertedWithCustomError(contract, 'WalletGlobalLimitExceeded');
    });
  });

  describe('Token URI suffix', () => {
    it('can set tokenURI suffix', async () => {
      await contract.setTokenURISuffix('.json');
      await contract.setBaseURI(
        'ipfs://bafybeidntqfipbuvdhdjosntmpxvxyse2dkyfpa635u4g6txruvt5qf7y4/',
      );

      const block = await ethers.provider.getBlock(
        await ethers.provider.getBlockNumber(),
      );
      // +10 is a number bigger than the count of transactions up to mint
      const stageStart = block.timestamp + 10;
      // Set stages
      await contract.setStages([
        {
          price: ethers.parseEther('0.1'),
          mintFee: ethers.parseEther('0.01'),
          walletLimit: 0,
          merkleRoot: ethers.zeroPadValue('0x00', 32),
          maxStageSupply: 0,
          startTimeUnixSeconds: stageStart,
          endTimeUnixSeconds: stageStart + 1,
        },
      ]);
      // Setup the test context: Update block.timestamp to comply to the stage being active
      await ethers.provider.send('evm_mine', [stageStart - 1]);
      // Mint and verify
      await contract.mint(
        1,
        0,
        [ethers.zeroPadValue('0x00', 32)],
        0,
        '0x00',
        {
          value: ethers.parseEther('0.11'),
        },
      );

      const tokenUri = await contract.tokenURI(0);
      expect(tokenUri).to.equal(
        'ipfs://bafybeidntqfipbuvdhdjosntmpxvxyse2dkyfpa635u4g6txruvt5qf7y4/0.json',
      );
    });
  });

  describe('Cosign', () => {
    it('can deploy with 0x0 cosign', async () => {
      const [owner, cosigner, fundReceiver] = await ethers.getSigners();
      const ERC721M = await ethers.getContractFactory('ERC721M');
      const erc721M = await ERC721M.deploy(
        'Test',
        'TEST',
        '',
        1000,
        0,
        ethers.ZeroAddress,
        60,
        ethers.ZeroAddress,
        fundReceiver.getAddress(),
      );
      await erc721M.waitForDeployment();
      const ownerConn = erc721M.connect(owner);
      await expect(
        ownerConn.getCosignDigest(owner.getAddress(), 1, false, 0, 0),
      ).to.be.revertedWithCustomError(ownerConn, 'CosignerNotSet');

      // we can set the cosigner
      await ownerConn.setCosigner(cosigner.getAddress());

      // readonly contract can't set cosigner
      await expect(
        readonlyContract.setCosigner(cosigner.getAddress()),
      ).to.be.revertedWithCustomError(readonlyContract, 'Unauthorized');
    });

    it('can deploy with cosign', async () => {
      const [_, minter, cosigner, fundReceiver] = await ethers.getSigners();
      const ERC721M = await ethers.getContractFactory('ERC721M');
      const erc721M = await ERC721M.deploy(
        'Test',
        'TEST',
        '',
        1000,
        0,
        cosigner.getAddress(),
        60,
        ethers.ZeroAddress,
        fundReceiver.getAddress(),
      );
      await erc721M.waitForDeployment();

      const minterConn = erc721M.connect(minter);
      const timestamp = Math.floor(new Date().getTime() / 1000);
      const sig = await getCosignSignature(
        erc721M,
        cosigner,
        await minter.getAddress(),
        timestamp,
        1,
        false,
      );
      await expect(
        minterConn.assertValidCosign(minter.getAddress(), 1, timestamp, sig, 0),
      ).to.not.be.reverted;

      const invalidSig = sig + '00';
      await expect(
        minterConn.assertValidCosign(
          minter.getAddress(),
          1,
          timestamp,
          invalidSig,
          0,
        ),
      ).to.be.revertedWithCustomError(minterConn, 'InvalidCosignSignature');
    });
  });
});
