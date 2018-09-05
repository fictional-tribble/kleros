/* globals artifacts, contract, expect, web3 */
const { expectThrow } = require('kleros-interaction/helpers/utils')

const Pinakion = artifacts.require(
  'kleros-interaction/contracts/standard/arbitration/ArbitrableTokens/MiniMeTokenERC20.sol'
)
const ConstantNG = artifacts.require(
  'kleros-interaction/contracts/standard/rng/ConstantNG.sol'
)
const KlerosLiquid = artifacts.require('./kleros/KlerosLiquid.sol')

// Helpers
const randomInt = (max, min = 1) =>
  Math.max(min, Math.ceil(Math.random() * max))
const generateSubcourts = (
  K,
  depth,
  ID = 0,
  minStake = 0,
  subcourtMap = {}
) => {
  const newMinStake = Math.max(randomInt(100), minStake)
  const subcourtTree = {
    ID,
    hiddenVotes: Math.random() < 0.5,
    minStake: newMinStake,
    alpha: randomInt(1000),
    jurorFee: randomInt(100),
    minJurors: randomInt(5, 3),
    jurorsForJump: randomInt(15, 3),
    timesPerPeriod: [...new Array(4)].map(_ => randomInt(5)),
    sortitionSumTreeK: randomInt(5),
    children:
      depth > 1
        ? [...new Array(K)].map(
            (_, i) =>
              generateSubcourts(
                K,
                depth - 1,
                K * ID + i + 1,
                newMinStake,
                subcourtMap
              ).subcourtTree
          )
        : undefined
  }
  if (ID === 0) subcourtTree.parent = 0
  else {
    subcourtTree.parent = Math.floor((ID - 1) / K)
    subcourtMap[subcourtTree.ID] = {
      ...subcourtTree,
      children:
        subcourtTree.children && subcourtTree.children.map(child => child.ID)
    }
  }
  return { subcourtTree, subcourtMap }
}
const checkOnlyByGovernor = async (
  getter,
  value,
  method,
  nextValue,
  invalidFrom,
  nextFrom
) => {
  await method(nextValue) // Set the next value
  expect(await getter()).to.deep.equal(
    nextValue === Number(nextValue) ? web3.toBigNumber(nextValue) : nextValue
  ) // Check it was set properly
  await expectThrow(method(value, { from: invalidFrom })) // Throw when setting from a non governor address
  await method(value, nextFrom && { from: nextFrom }) // Set back to the original value
}
const asyncForEach = async (method, iterable) => {
  const array = Array.isArray(iterable) ? iterable : Object.values(iterable)
  for (const item of array) await method(item)
}

contract('KlerosLiquid', accounts =>
  it('Should implement the spec, https://docs.google.com/document/d/17aqJ0LTLJrQNSk07Cwop4JVRmicaCLi1I4UfYeSw96Y.', async () => {
    // Deploy contracts and generate subcourts
    const pinakion = await Pinakion.new(
      0x0, // _tokenFactory
      0x0, // _parentToken
      0, // _parentSnapShotBlock
      'Pinakion', // _tokenName
      18, // _decimalUnits
      'PNK', // _tokenSymbol
      true // _transfersEnabled
    )
    const randomNumber = 10
    const RNG = await ConstantNG.new(randomNumber)
    const governor = accounts[0]
    const minStakingTime = 1
    const maxDrawingTime = 1
    const { subcourtTree, subcourtMap } = generateSubcourts(randomInt(4, 2), 3)
    const klerosLiquid = await KlerosLiquid.new(
      governor,
      pinakion.address,
      RNG.address,
      minStakingTime,
      maxDrawingTime,
      subcourtTree.hiddenVotes,
      subcourtTree.minStake,
      subcourtTree.alpha,
      subcourtTree.jurorFee,
      subcourtTree.minJurors,
      subcourtTree.jurorsForJump,
      subcourtTree.timesPerPeriod,
      subcourtTree.sortitionSumTreeK
    )

    // Test general governance
    await checkOnlyByGovernor(
      klerosLiquid.governor,
      governor,
      klerosLiquid.changeGovernor,
      accounts[1],
      accounts[2],
      accounts[1]
    )
    await checkOnlyByGovernor(
      klerosLiquid.pinakion,
      pinakion.address,
      klerosLiquid.changePinakion,
      '0x0000000000000000000000000000000000000000',
      accounts[2]
    )
    await checkOnlyByGovernor(
      klerosLiquid.RNGenerator,
      RNG.address,
      klerosLiquid.changeRNGenerator,
      '0x0000000000000000000000000000000000000000',
      accounts[2]
    )
    await checkOnlyByGovernor(
      klerosLiquid.minStakingTime,
      minStakingTime,
      klerosLiquid.changeMinStakingTime,
      0,
      accounts[2]
    )
    await checkOnlyByGovernor(
      klerosLiquid.maxDrawingTime,
      maxDrawingTime,
      klerosLiquid.changeMaxDrawingTime,
      0,
      accounts[2]
    )

    // Create subcourts and check hierarchy
    await asyncForEach(
      subcourt =>
        klerosLiquid.createSubcourt(
          subcourt.parent,
          subcourt.hiddenVotes,
          subcourt.minStake,
          subcourt.alpha,
          subcourt.jurorFee,
          subcourt.minJurors,
          subcourt.jurorsForJump,
          subcourt.timesPerPeriod,
          subcourt.sortitionSumTreeK
        ),
      subcourtMap
    )
    await asyncForEach(
      async subcourt =>
        expect(await klerosLiquid.courts(subcourt.ID)).to.deep.equal([
          web3.toBigNumber(subcourt.parent),
          subcourt.hiddenVotes,
          web3.toBigNumber(subcourt.minStake),
          web3.toBigNumber(subcourt.alpha),
          web3.toBigNumber(subcourt.jurorFee),
          web3.toBigNumber(subcourt.minJurors),
          web3.toBigNumber(subcourt.jurorsForJump)
        ]),
      subcourtMap
    )

    // Test moving a subcourt
    const subcourtToMove = subcourtTree.children[0].children[0].ID
    const subcourtToMoveMinStake = subcourtMap[subcourtToMove].minStake
    const parent = 1
    const nextParent = 2

    // Move subcourt and check hierarchy
    subcourtMap[subcourtToMove].minStake = 100
    await klerosLiquid.changeSubcourtMinStake(subcourtToMove, 100)
    subcourtMap[subcourtToMove].parent = nextParent
    await klerosLiquid.moveSubcourt(subcourtToMove, nextParent)
    await asyncForEach(
      async subcourt =>
        expect(await klerosLiquid.courts(subcourt.ID)).to.deep.equal([
          web3.toBigNumber(subcourt.parent),
          subcourt.hiddenVotes,
          web3.toBigNumber(subcourt.minStake),
          web3.toBigNumber(subcourt.alpha),
          web3.toBigNumber(subcourt.jurorFee),
          web3.toBigNumber(subcourt.minJurors),
          web3.toBigNumber(subcourt.jurorsForJump)
        ]),
      subcourtMap
    )

    // Move it back and check hierarchy
    subcourtMap[subcourtToMove].minStake = subcourtToMoveMinStake
    await klerosLiquid.changeSubcourtMinStake(
      subcourtToMove,
      subcourtToMoveMinStake
    )
    subcourtMap[subcourtToMove].parent = parent
    await klerosLiquid.moveSubcourt(subcourtToMove, parent)
    await asyncForEach(
      async subcourt =>
        expect(await klerosLiquid.courts(subcourt.ID)).to.deep.equal([
          web3.toBigNumber(subcourt.parent),
          subcourt.hiddenVotes,
          web3.toBigNumber(subcourt.minStake),
          web3.toBigNumber(subcourt.alpha),
          web3.toBigNumber(subcourt.jurorFee),
          web3.toBigNumber(subcourt.minJurors),
          web3.toBigNumber(subcourt.jurorsForJump)
        ]),
      subcourtMap
    )

    // Test subcourt governance
    await checkOnlyByGovernor(
      async () => (await klerosLiquid.courts(0))[1],
      subcourtTree.hiddenVotes,
      (nextValue, ...args) =>
        klerosLiquid.changeSubcourtHiddenVotes(0, nextValue, ...args),
      true,
      accounts[2]
    )
    await checkOnlyByGovernor(
      async () => (await klerosLiquid.courts(0))[2],
      subcourtTree.minStake,
      (nextValue, ...args) =>
        klerosLiquid.changeSubcourtMinStake(0, nextValue, ...args),
      0,
      accounts[2]
    )
    await checkOnlyByGovernor(
      async () => (await klerosLiquid.courts(0))[3],
      subcourtTree.alpha,
      (nextValue, ...args) =>
        klerosLiquid.changeSubcourtAlpha(0, nextValue, ...args),
      0,
      accounts[2]
    )
    await checkOnlyByGovernor(
      async () => (await klerosLiquid.courts(0))[4],
      subcourtTree.jurorFee,
      (nextValue, ...args) =>
        klerosLiquid.changeSubcourtJurorFee(0, nextValue, ...args),
      0,
      accounts[2]
    )
    await checkOnlyByGovernor(
      async () => (await klerosLiquid.courts(0))[5],
      subcourtTree.minJurors,
      (nextValue, ...args) =>
        klerosLiquid.changeSubcourtMinJurors(0, nextValue, ...args),
      0,
      accounts[2]
    )
    await checkOnlyByGovernor(
      async () => (await klerosLiquid.courts(0))[6],
      subcourtTree.jurorsForJump,
      (nextValue, ...args) =>
        klerosLiquid.changeSubcourtJurorsForJump(0, nextValue, ...args),
      0,
      accounts[2]
    )
    await klerosLiquid.changeSubcourtTimesPerPeriod(
      0,
      subcourtTree.timesPerPeriod
    )
  })
)
