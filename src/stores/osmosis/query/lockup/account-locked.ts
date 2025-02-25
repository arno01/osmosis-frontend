import { ChainGetter, QueryResponse, ObservableChainQuery, ObservableChainQueryMap } from '@keplr-wallet/stores';
import { KVStore } from '@keplr-wallet/common';
import { AccountLockedLongerDuration } from './types';
import { makeObservable } from 'mobx';
import { computedFn } from 'mobx-utils';
import { Duration } from 'dayjs/plugin/duration';
import { CoinPretty, Dec } from '@keplr-wallet/unit';
import { AppCurrency } from '@keplr-wallet/types';

export class ObservableQueryAccountLockedInner extends ObservableChainQuery<AccountLockedLongerDuration> {
	constructor(kvStore: KVStore, chainId: string, chainGetter: ChainGetter, protected readonly bech32Address: string) {
		// 좀 트윅한 방식으로 밑의 rest를 duration 설정 없이 이용해서 계정의 모든 lock들을 받아온다.
		super(kvStore, chainId, chainGetter, `/osmosis/lockup/v1beta1/account_locked_longer_duration/${bech32Address}`);

		makeObservable(this);
	}

	protected canFetch(): boolean {
		// 위의 쿼리는 주소가 비어있을 경우 모든 계정의 해당 결과를 리턴한다.
		// 하지만 이 특징은 이 프론트엔드에서는 필요가 없으므로 주소가 비어있으면 쿼리 자체를 하지 않는다.
		return this.bech32Address !== '';
	}

	protected setResponse(response: Readonly<QueryResponse<AccountLockedLongerDuration>>) {
		super.setResponse(response);

		const chainInfo = this.chainGetter.getChain(this.chainId);
		const unknownCurrencies: string[] = [];
		for (const lock of response.data.locks) {
			unknownCurrencies.push(...lock.coins.map(coin => coin.denom));
		}
		// Remove duplicates.
		chainInfo.addUnknownCurrencies(...[...new Set(unknownCurrencies)]);
	}

	readonly getLockedCoinWithDuration = computedFn((currency: AppCurrency, duration: Duration): {
		amount: CoinPretty;
		lockIds: string[];
	} => {
		if (!this.response) {
			return {
				amount: new CoinPretty(currency, new Dec(0)),
				lockIds: [],
			};
		}

		const matchedLocks = this.response.data.locks
			.filter(lock => {
				// Ignore milli sec
				return Number.parseInt(lock.duration.replace('s', '')) + 's' === `${duration.asSeconds()}s`;
			})
			.filter(lock => {
				// Filter the unlocking, unlockable locks.
				return new Date(lock.end_time).getTime() <= 0;
			});

		let coin = new CoinPretty(currency, new Dec(0));
		for (const lock of matchedLocks) {
			const matchedCoin = lock.coins.find(coin => coin.denom === currency.coinMinimalDenom);
			if (matchedCoin) {
				coin = coin.add(new CoinPretty(currency, new Dec(matchedCoin.amount)));
			}
		}

		return {
			amount: coin,
			lockIds: matchedLocks.map(lock => lock.ID),
		};
	});

	readonly getUnlockingCoinWithDuration = computedFn((currency: AppCurrency, duration: Duration): {
		amount: CoinPretty;
		lockIds: string[];
		endTime: Date;
	}[] => {
		if (!this.response) {
			return [];
		}

		const matchedLocks = this.response.data.locks
			.filter(lock => {
				// Ignore milli sec
				return Number.parseInt(lock.duration.replace('s', '')) + 's' === `${duration.asSeconds()}s`;
			})
			.filter(lock => {
				// Filter the locked.
				return new Date(lock.end_time).getTime() > 0;
			});

		// End time 별로 구분하기 위한 map. key는 end time의 getTime()의 결과이다.
		const map: Map<
			number,
			{
				amount: CoinPretty;
				lockIds: string[];
				endTime: Date;
			}
		> = new Map();

		for (const lock of matchedLocks) {
			const matchedCoin = lock.coins.find(coin => coin.denom === currency.coinMinimalDenom);
			if (matchedCoin) {
				const time = new Date(lock.end_time).getTime();
				if (!map.has(time)) {
					map.set(time, {
						amount: new CoinPretty(currency, new Dec(0)),
						lockIds: [],
						endTime: new Date(lock.end_time),
					});
				}

				const value = map.get(time)!;
				value.amount = value.amount.add(new CoinPretty(currency, new Dec(matchedCoin.amount)));
				value.lockIds.push(lock.ID);

				map.set(time, value);
			}
		}

		return [...map.values()].sort((v1, v2) => {
			// End time이 더 적은 lock을 우선한다.
			return v1.endTime > v2.endTime ? 1 : -1;
		});
	});
}

export class ObservableQueryAccountLocked extends ObservableChainQueryMap<AccountLockedLongerDuration> {
	constructor(kvStore: KVStore, chainId: string, chainGetter: ChainGetter) {
		super(kvStore, chainId, chainGetter, (bech32Address: string) => {
			return new ObservableQueryAccountLockedInner(this.kvStore, this.chainId, this.chainGetter, bech32Address);
		});
	}

	get(bech32Address: string): ObservableQueryAccountLockedInner {
		return super.get(bech32Address) as ObservableQueryAccountLockedInner;
	}
}
