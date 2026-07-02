window.Hyumu = window.Hyumu || {};

Hyumu.Scheduler = (function () {
  const Model = Hyumu.Model;

  function setCell(schedule, empId, date, status, source, shift) {
    schedule[empId][date] = { status, source, shift: shift || null };
  }

  function isLocked(schedule, empId, date) {
    const cell = schedule[empId][date];
    return !!cell && (cell.source === 'BASE' || cell.source === 'MANUAL');
  }

  // Personal annual leave (연차) and 인정 leave are separate from the fairness/rest-day
  // rotation: an employee who already used annual leave should still receive their full
  // share of auto-assigned rest on top of it, not have the annual leave count against it.
  const EXEMPT_LEAVE_TYPES = ['ANNUAL', 'RECOGNIZED'];
  function isExemptLockedOff(emp, date, schedule) {
    const cell = schedule[emp.id][date];
    if (!cell || cell.status !== 'OFF' || cell.source !== 'BASE') return false;
    if (!emp.specificOff.includes(date)) return false;
    return EXEMPT_LEAVE_TYPES.includes(Model.leaveTypeOf(emp, date));
  }

  // Would giving `emp` a new OFF day on `date` push any of their corners below its own
  // morning+afternoon minimum? Used by the catch-up swap passes so they can't quietly
  // re-violate a corner minimum that Phase 1 already respected while chasing the target
  // off-days count.
  function wouldExceedCornerCap(schedule, employees, cornerAllowedOff, emp, date) {
    const empCorners = Model.employeeCorners(emp);
    if (empCorners.length === 0) return false;
    const cornerOffToday = {};
    employees.forEach((other) => {
      if (other.id === emp.id) return;
      // `other` may belong to a department group that hasn't run its Phase 1 fill yet (groups
      // run sequentially), so its cell for this date can still be unset — treat that as "not
      // off" rather than crashing; that group's own Phase 1 will account for it when it runs.
      const otherCell = schedule[other.id][date];
      if (!otherCell || otherCell.status !== 'OFF') return;
      Model.employeeCorners(other).forEach((c) => {
        cornerOffToday[c] = (cornerOffToday[c] || 0) + 1;
      });
    });
    return empCorners.some((c) => cornerAllowedOff[c] != null && (cornerOffToday[c] || 0) >= cornerAllowedOff[c]);
  }

  function generateSchedule(doc) {
    const { employees, rules, month } = doc;
    const dates = Model.allDatesOfMonth(month.year, month.month);

    const schedule = {};
    employees.forEach((emp) => {
      schedule[emp.id] = {};
    });

    // BASE cells are always recomputed fresh from employee definitions
    for (const emp of employees) {
      for (const date of dates) {
        if (Model.isBaseOff(emp, date)) {
          setCell(schedule, emp.id, date, 'OFF', 'BASE');
        }
      }
    }

    // carry forward previously saved MANUAL locks
    if (doc.schedule) {
      for (const emp of employees) {
        const prevEmp = doc.schedule[emp.id];
        if (!prevEmp) continue;
        for (const date of dates) {
          const prevCell = prevEmp[date];
          if (prevCell && prevCell.source === 'MANUAL') {
            setCell(schedule, emp.id, date, prevCell.status, 'MANUAL', prevCell.shift);
          }
        }
      }
    }

    const conflicts = [];

    if (employees.length === 0) {
      doc.schedule = schedule;
      doc.conflicts = conflicts;
      return doc;
    }

    // 문구/서적은 각자 최소근무인원/연속근무/오전조/오후조 기준이 별도라서(사장님 지시),
    // 부서별로 완전히 독립적인 인원 풀로 나눠서 각자의 Phase 1 + 재조정을 따로 돌린다.
    // 관리(점장/파트장/영업지원)는 어느 부서에도 안 속하니 store-wide 기본 규칙(rules 최상위
    // 필드)을 그대로 쓰는 별도 풀로 처리한다.
    const deptEmployees = { '문구': [], '서적': [] };
    const adminEmployees = [];
    employees.forEach((emp) => {
      const dept = Model.employeeDepartment(emp);
      if (dept === '문구' || dept === '서적') deptEmployees[dept].push(emp);
      else adminEmployees.push(emp);
    });

    // 코너별(기프트/학용/문보장 등) 오전+오후 최소 인원은 부서 분리와 무관하게 매장 전체
    // 기준으로 지켜져야 한다 — 예를 들어 기프트 담당자 중 한 명이 파트장을 겸해 관리 그룹으로
    // 빠지더라도, 문구 그룹과 관리 그룹이 서로 몰라서 같은 날 기프트를 동시에 비우면 안 된다.
    // 그래서 코너 인원수/허용 휴무치는 부서별이 아니라 전체 employees 기준으로 한 번만 계산해
    // 모든 그룹의 Phase 1/재조정 패스에 공통으로 넘긴다.
    const cornerShiftMinGlobal = rules.minStaffByCorner || {};
    const cornerMinStaffGlobal = {};
    Object.entries(cornerShiftMinGlobal).forEach(([corner, req]) => {
      cornerMinStaffGlobal[corner] = (req.morning || 0) + (req.afternoon || 0);
    });
    const cornerTotalGlobal = {};
    employees.forEach((emp) => {
      Model.employeeCorners(emp).forEach((c) => {
        cornerTotalGlobal[c] = (cornerTotalGlobal[c] || 0) + 1;
      });
    });
    // 파트장은 몇 명이 동시에 쉬든 상관없지만, 매장에 파트장이 단 한 명도 없는 날은 절대
    // 없어야 한다(사장님 지시: "최대 1명은 근무해야 한다는거야" — 동시에 여럿이 쉬는 건 괜찮고,
    // 항상 최소 1명은 근무해야 한다는 뜻). 코너 최소 인원 설정 여부와 무관하게 이 하한을
    // 강제로 걸어둔다. 사용자가 규칙 화면에서 '파트장' 코너에 이보다 더 엄격한(=더 높은)
    // 오전/오후 최소치를 직접 설정했다면 그 값이 우선한다.
    const partLeaderCount = cornerTotalGlobal['파트장'] || 0;
    if (partLeaderCount > 0) {
      cornerMinStaffGlobal['파트장'] = Math.max(cornerMinStaffGlobal['파트장'] || 0, 1);
    }
    const cornerAllowedOff = {};
    Object.keys(cornerTotalGlobal).forEach((corner) => {
      cornerAllowedOff[corner] = Math.max(0, cornerTotalGlobal[corner] - (cornerMinStaffGlobal[corner] || 0));
    });

    // Collected across every group so backfillPartLeaders can tell whether pulling a specific
    // 파트장 back to WORK would drop them below their own guaranteed rest-day count, and so a
    // final safety pass can verify nobody's consecutive-work cap got broken along the way.
    const targetByEmpId = {};
    const personalCapByEmpId = {};

    const deptRules = rules.deptRules || {};
    ['문구', '서적'].forEach((dept) => {
      if (deptEmployees[dept].length === 0) return;
      const groupRules = Object.assign({}, rules, deptRules[dept] || {});
      const result = runGroupSchedule(deptEmployees[dept], groupRules, schedule, dates, conflicts, employees, cornerAllowedOff, cornerMinStaffGlobal);
      Object.assign(targetByEmpId, result.target);
      Object.assign(personalCapByEmpId, result.personalCap);
    });

    // Dates where 문구/서적's own dedicated staff already falls short of their department
    // minimum — these are exactly the dates backfillPartLeaders will later need to pull a 파트장
    // into WORK on. Computed now (after 문구/서적 are scheduled, before 관리 is) so the 관리
    // group's own slack-fill pass below can avoid spending a 파트장's extra rest day on one of
    // these dates — otherwise slack-fill hands a day off to whoever's most behind, backfill then
    // immediately takes it back (since with the "max 1 파트장 off/day" cap, whoever slack-fill
    // picked is often the *only* 파트장 free to pull that day), and the two passes fight every
    // regeneration instead of the group ever actually evening out.
    const deptShortfallDates = new Set();
    ['문구', '서적'].forEach((dept) => {
      if (deptEmployees[dept].length === 0) return;
      const groupRules = Object.assign({}, rules, deptRules[dept] || {});
      dates.forEach((date) => {
        const req = Math.max(Model.minStaffRequired(groupRules, date), (groupRules.minMorningStaff || 0) + (groupRules.minAfternoonStaff || 0));
        const working = deptEmployees[dept].filter((e) => schedule[e.id][date].status === 'WORK').length;
        if (working < req) deptShortfallDates.add(date);
      });
    });

    if (adminEmployees.length > 0) {
      // 관리(점장/파트장/영업지원)는 store-wide 최소인원 수치를 그대로 물려받으면 안 된다 —
      // 그 수치는 문구/서적처럼 여러 명 규모의 부서를 염두에 두고 정한 값이라, 관리 인원(대개
      // 1~3명)에 그대로 적용하면 매일 인원 부족으로 뜬다. 관리는 인원 하한 없이 목표
      // 휴무일수 페이스와 연속근무 제한만 따른다(점장은 상관없다는 사장님 지시).
      const adminRules = Object.assign({}, rules, { minStaffDefault: 0, minMorningStaff: 0, minAfternoonStaff: 0 });
      const adminResult = runGroupSchedule(adminEmployees, adminRules, schedule, dates, conflicts, employees, cornerAllowedOff, cornerMinStaffGlobal, deptShortfallDates);
      Object.assign(targetByEmpId, adminResult.target);
      Object.assign(personalCapByEmpId, adminResult.personalCap);
    }

    // 파트장은 어느 한 부서가 도저히 최소인원을 못 맞출 때 그 부서에 투입돼야 한다(사장님 지시) —
    // 단, 그 파트장 본인의 목표 휴무일수(법정 휴무: 빨간날/공휴일 + 이미 쓴 연차·체단·인정)를
    // 깎으면서까지는 안 된다. 휴무 갯수는 넘버원 원칙이라, 이미 목표만큼만 쉬고 있는 사람은
    // 투입 대상에서 제외한다(사장님 지시: "가깝게? 그거 안돼... 법적으로 지켜야할 사항이야").
    backfillPartLeaders(schedule, employees, deptEmployees, deptRules, rules, dates, conflicts, targetByEmpId);

    // Final safety net: multiple passes above (rebalance, trim, backfill) each individually check
    // the consecutive-work cap before converting a rest day back to WORK, but a bug in any one of
    // them can still slip a violation through — and this is a hard, non-negotiable limit (사장님
    // 지시: "연속근무제한이 왜 문제라는거니 ... 무조건 휴무가 먼저", confirmed on real data: a
    // 6-day streak had slipped through here before this pass existed). So re-verify every
    // employee's actual final schedule directly and force a rest day back in wherever a streak
    // still exceeds their cap, no matter which pass caused it.
    enforceConsecutiveCap(schedule, employees, dates, personalCapByEmpId, conflicts);

    assignShifts(schedule, employees, dates, rules, conflicts);

    doc.schedule = schedule;
    doc.conflicts = conflicts;
    return doc;
  }

  // Runs the full Phase 1 greedy fill + rebalance passes for one self-contained pool of
  // employees (a department, or the 관리 catch-all), writing into the shared `schedule` and
  // `conflicts`. Everything here only ever looks at `groupEmployees` — no cross-group effects.
  function runGroupSchedule(groupEmployees, rules, schedule, dates, conflicts, allEmployees, cornerAllowedOff, cornerMinStaffGlobal, excludeDatesForSlack) {
    const n = groupEmployees.length;
    const employees = groupEmployees;

    const consecutiveWork = {};
    const totalOff = {};
    const weekendOff = {};
    const redDayOff = {};
    const fairnessOff = {};
    employees.forEach((emp) => {
      consecutiveWork[emp.id] = 0;
      totalOff[emp.id] = 0;
      weekendOff[emp.id] = 0;
      redDayOff[emp.id] = 0;
      fairnessOff[emp.id] = 0;
    });

    // lockedOffCount excludes exempt (연차/인정) leave so those days don't eat into the
    // guaranteed auto-rest target; fairnessOff (built up below in the Phase 1 loop) mirrors
    // this by excluding exempt days from the running deficit calculation too.
    const lockedOffCount = {};
    employees.forEach((emp) => {
      lockedOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of dates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) lockedOffCount[emp.id]++;
      }
    }

    // 목표 휴무일수(rules.targetOffDays)가 있으면 그게 곧 목표다 — 최소 근무 인원에서
    // 역산한 값이 아니라, 사용자가 직접 정한 숫자. 최소 인원 요건은 이 목표를 채우는 데
    // 방해가 되면 안 되고(휴무가 최우선), 아래 Phase 1에서도 일일 남은 슬롯 계산을 이
    // 목표에 맞춰 페이싱하지 최소인원 여유분으로 캡을 걸지 않는다.
    const baseTarget = rules.targetOffDays != null && rules.targetOffDays !== ''
      ? Number(rules.targetOffDays)
      : (() => {
          let totalOffSlots = 0;
          for (const date of dates) {
            const req = Model.minStaffRequired(rules, date);
            totalOffSlots += Math.max(0, n - req);
          }
          return totalOffSlots / n;
        })();
    const target = {};
    employees.forEach((emp) => {
      target[emp.id] = Math.max(lockedOffCount[emp.id], baseTarget);
    });
    const totalTargetSum = employees.reduce((sum, emp) => sum + target[emp.id], 0);

    const cap = rules.maxConsecutiveWorkDays;
    const effectiveCap = rules.minRestPerWeekWindow ? Math.min(cap, 6) : cap;

    // A user-configured rule: if an employee's locked (연차 등 확정된) rest block runs at
    // least rules.longBreakDays days in a row, the consecutive-work cap around it is relaxed
    // to rules.extendedWorkCap for that person, for the whole month — a long break justifies
    // working a bit more before/after it. Falls back to the plain cap when unset.
    const personalCap = {};
    employees.forEach((emp) => {
      let personal = effectiveCap;
      if (rules.longBreakDays != null && rules.extendedWorkCap != null) {
        let longestLockedRun = 0;
        let run = 0;
        for (const date of dates) {
          if (Model.isBaseOff(emp, date)) {
            run++;
            longestLockedRun = Math.max(longestLockedRun, run);
          } else {
            run = 0;
          }
        }
        if (longestLockedRun >= rules.longBreakDays) personal = Math.max(effectiveCap, rules.extendedWorkCap);
      }
      personalCap[emp.id] = personal;
    });

    const shiftMinTotal = (rules.minMorningStaff || 0) + (rules.minAfternoonStaff || 0);

    // cornerAllowedOff/cornerMinStaffGlobal are computed once in generateSchedule from ALL
    // employees store-wide (not just this group) — a corner like 기프트 can have members split
    // across departments (e.g. a 파트장 who also covers 기프트, routed into the 관리 group), so
    // the cap has to be shared across every group's Phase 1 fill and catch-up passes, or two
    // groups can each grant OFF to "their" share of the same corner without seeing each other.
    const cornerMinStaff = cornerMinStaffGlobal;

    // Fairness group headcount: small sub-corners (e.g. 기프트/학용/필기구/디자인문구)
    // are pooled together per Model.cornerFairnessGroup so red-day rest is shared
    // across the whole pool rather than computed per tiny individual corner.
    const fairnessGroupTotal = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      if (corners.length === 1) {
        const key = Model.cornerFairnessGroup(corners[0]);
        if (key) fairnessGroupTotal[key] = (fairnessGroupTotal[key] || 0) + 1;
      }
    });

    // Red-day (Sat/Sun/holiday) fairness: each employee should get an even share of
    // red-day OFF within their own corner, since red days are when the store needs
    // the most coverage and weekdays are when everyone rests anyway.
    const redDates = dates.filter((date) => Model.isWeekend(date) || Model.isRedDay(date));
    const lockedRedDayOffCount = {};
    employees.forEach((emp) => {
      lockedRedDayOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of redDates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) lockedRedDayOffCount[emp.id]++;
      }
    }
    const fairnessRedDayOff = {};
    employees.forEach((emp) => { fairnessRedDayOff[emp.id] = 0; });
    const redDayTarget = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      let base;
      if (corners.length === 1) {
        const key = Model.cornerFairnessGroup(corners[0]);
        if (key && fairnessGroupTotal[key]) {
          base = redDates.length / fairnessGroupTotal[key];
        } else {
          base = redDates.length / n;
        }
      } else {
        base = redDates.length / n;
      }
      redDayTarget[emp.id] = Math.max(lockedRedDayOffCount[emp.id], base);
    });

    // Phase 1: chronological greedy fill
    // totalOffSoFar tracks the running sum of fairnessOff across all employees, used below to
    // pace daily rest slots against the target instead of against staffing headroom.
    let totalOffSoFar = 0;
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      const date = dates[dayIndex];
      const weekend = Model.isWeekend(date);
      const redDay = weekend || Model.isRedDay(date);
      const req = Math.max(Model.minStaffRequired(rules, date), shiftMinTotal);

      const lockedEmployees = [];
      const freeEmployees = [];
      for (const emp of employees) {
        if (isLocked(schedule, emp.id, date)) lockedEmployees.push(emp);
        else freeEmployees.push(emp);
      }
      const fixedOffCount = lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').length;

      if (n - fixedOffCount < req) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 고정/수동 휴무만으로 최소 근무 인원(${req}명)을 채울 수 없습니다.`,
          employeeIds: lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').map((e) => e.id)
        });
      }

      // How much rest today's own staffing minimum allows, before touching the monthly target
      // pacing at all — a day that genuinely needs full staffing shouldn't get emptied out just
      // because the month-wide rest quota has room, and a slack day (nobody on leave, more
      // people available than the minimum) should absorb extra rest rather than overstaffing.
      const allowedAdditionalOff = Math.max(0, n - req - fixedOffCount);

      const forcedOff = freeEmployees.filter((emp) => consecutiveWork[emp.id] >= personalCap[emp.id]);
      const forcedIds = new Set(forcedOff.map((e) => e.id));

      if (forcedOff.length > allowedAdditionalOff) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 연속 근무 제한(${effectiveCap}일)으로 쉬어야 하는 인원이 많아 최소 근무 인원(${req}명)을 유지할 수 없습니다.`,
          employeeIds: forcedOff.map((e) => e.id)
        });
      }

      forcedOff.forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FORCED'));

      // Pace today's rest slots against the target trajectory (how much of totalTargetSum
      // "should" be used up by this point in the month). Normally capped by the day's own
      // staffing room (allowedAdditionalOff) so a fully-staffed day doesn't get overstaffed
      // and a low-staffing day doesn't get emptied for no reason — the target/staffing gap
      // that this creates gets caught up later by rebalanceDecoupled's escalated passes,
      // which are the ones allowed to actually dip below minimum staffing when unavoidable.
      const desiredCumulative = Math.round((totalTargetSum * (dayIndex + 1)) / dates.length);
      const paceSlots = Math.max(0, desiredCumulative - totalOffSoFar - forcedOff.length);
      const reqRoom = Math.max(0, allowedAdditionalOff - forcedOff.length);
      const remainingSlots = Math.min(paceSlots, reqRoom);
      const candidates = freeEmployees.filter((emp) => !forcedIds.has(emp.id));

      // Per-corner OFF budget: same principle as the store-wide staffing room above — respect
      // each corner's own morning+afternoon minimum first when picking who rests today, and only
      // let the month-end catch-up passes (rebalanceDecoupled/trim) breach it as a last resort.
      // Scan ALL employees (not just this group) so a corner already emptied out by another
      // group's earlier pass (or by that other group's own locked/forced OFF today) is seen here.
      const cornerOffUsed = {};
      allEmployees.forEach((emp) => {
        const cell = schedule[emp.id][date];
        if (!cell || cell.status !== 'OFF') return;
        Model.employeeCorners(emp).forEach((c) => {
          cornerOffUsed[c] = (cornerOffUsed[c] || 0) + 1;
        });
      });
      Object.entries(cornerOffUsed).forEach(([corner, used]) => {
        if (cornerAllowedOff[corner] != null && used > cornerAllowedOff[corner]) {
          conflicts.push({
            date,
            type: 'CORNER_MIN_STAFF_VIOLATION',
            message: `${date}: 고정/수동/강제 휴무만으로 '${corner}' 코너 최소 인원(${cornerMinStaff[corner] || 0}명)을 채울 수 없습니다.`,
            employeeIds: []
          });
        }
      });
      // A sibling department is already short-staffed on this date, so every 파트장 needs to stay
      // available for backfillPartLeaders rather than one of them taking rest here — block ANY
      // new 파트장 rest pick today (not just once the cap is reached), since backfillPartLeaders
      // will pull in whoever it can regardless of how many are already off, and every one Phase 1
      // adds here is one more that gets immediately reversed there. Applied only to the
      // candidate-blocking check below, after the real violation check above already ran, so this
      // synthetic block doesn't itself get misreported as a corner-minimum violation.
      if (excludeDatesForSlack && excludeDatesForSlack.has(date) && cornerAllowedOff['파트장'] != null) {
        cornerOffUsed['파트장'] = Infinity;
      }

      candidates.sort((a, b) => {
        if (redDay) {
          const redDeficitA = redDayTarget[a.id] - fairnessRedDayOff[a.id];
          const redDeficitB = redDayTarget[b.id] - fairnessRedDayOff[b.id];
          if (redDeficitB !== redDeficitA) return redDeficitB - redDeficitA;
        }
        const deficitA = target[a.id] - fairnessOff[a.id];
        const deficitB = target[b.id] - fairnessOff[b.id];
        if (deficitB !== deficitA) return deficitB - deficitA;
        if (weekend) {
          const wDiff = weekendOff[a.id] - weekendOff[b.id];
          if (wDiff !== 0) return wDiff;
        }
        const streakDiff = consecutiveWork[b.id] - consecutiveWork[a.id];
        if (streakDiff !== 0) return streakDiff;
        return employees.indexOf(a) - employees.indexOf(b);
      });

      const chosenOff = [];
      for (const emp of candidates) {
        if (chosenOff.length >= remainingSlots) break;
        // On red days, once someone has already taken their fair share of red-day rest,
        // leave them working rather than filling every allowed slot with rest -- red days
        // are meant to be mostly worked, only rotated rest per corner.
        if (redDay && fairnessRedDayOff[emp.id] >= Math.ceil(redDayTarget[emp.id])) continue;
        const empCorners = Model.employeeCorners(emp);
        const blocked = empCorners.some((c) => cornerAllowedOff[c] != null && (cornerOffUsed[c] || 0) >= cornerAllowedOff[c]);
        if (blocked) continue;
        chosenOff.push(emp);
        empCorners.forEach((c) => {
          cornerOffUsed[c] = (cornerOffUsed[c] || 0) + 1;
        });
      }
      const chosenOffIds = new Set(chosenOff.map((e) => e.id));

      candidates.filter((emp) => chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FAIRNESS'));
      candidates.filter((emp) => !chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'WORK', 'AUTO'));

      for (const emp of employees) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF') {
          consecutiveWork[emp.id] = 0;
          totalOff[emp.id]++;
          if (weekend) weekendOff[emp.id]++;
          if (redDay) redDayOff[emp.id]++;
          if (!isExemptLockedOff(emp, date, schedule)) {
            fairnessOff[emp.id]++;
            totalOffSoFar++;
            if (redDay) fairnessRedDayOff[emp.id]++;
          }
        } else {
          consecutiveWork[emp.id]++;
        }
      }
    }

    rebalanceRedDays(schedule, employees, allEmployees, redDates, dates, personalCap, cornerAllowedOff, fairnessRedDayOff, conflicts);
    // Recompute weekdayOff straight from the schedule (not by subtracting fairnessRedDayOff
    // from the pre-rebalance fairnessOff) — rebalanceRedDays just swapped OFF/WORK cells on
    // red days, so that subtraction would use a stale fairnessOff and desync from reality.
    const weekdayDates = dates.filter((date) => !(Model.isWeekend(date) || Model.isRedDay(date)));
    const weekdayOff = {};
    employees.forEach((emp) => {
      let count = 0;
      for (const date of weekdayDates) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) count++;
      }
      weekdayOff[emp.id] = count;
    });
    rebalance(schedule, employees, allEmployees, weekdayDates, dates, personalCap, cornerAllowedOff, weekdayOff, conflicts, true);

    // rebalance() above only trades OFF/WORK on the *same date* between two people, which stays
    // staffing-neutral for that day but can leave gaps unfixed simply because the two people who
    // need to trade never happen to have opposite status on the same date. Since the target
    // off-days count outranks staffing (사장님 지시), run one more pass that decouples the swap —
    // take a rest day off the highest person on whatever date works for them, and give a rest day
    // to the lowest person on whatever date works for them, independently. This reaches every
    // fixable gap the paired swaps couldn't, at the cost of possibly dipping staffing further on
    // the lowest person's chosen date (already flagged only informationally, not blocked).
    const monthOff = {};
    employees.forEach((emp) => {
      let count = 0;
      for (const date of dates) {
        if (schedule[emp.id][date].status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) count++;
      }
      monthOff[emp.id] = count;
    });
    rebalanceDecoupled(schedule, employees, allEmployees, dates, personalCap, cornerAllowedOff, monthOff, target, conflicts, excludeDatesForSlack);

    // rebalanceDecoupled only ever moves a day from someone OVER target to someone UNDER — if a
    // corner's shared cap is scarce enough that EVERYONE in it stays under target (e.g. 파트장:
    // only 1 of 4 can rest per day, so the group can't reach 9 each even at full capacity), there's
    // never an "over" person to take a day from, so leftover unused slack (a day nobody in that
    // corner is resting on, even though the cap would allow one more) just sits unused instead of
    // going to whoever's fallen furthest behind their corner-mates. This pass spends exactly that
    // leftover slack, evening the group out as far as the shared cap allows.
    fillCornerSlack(schedule, employees, allEmployees, dates, cornerAllowedOff, monthOff, target, excludeDatesForSlack);

    // 목표 휴무일수는 근사치가 아니라 반드시 정확히 맞아야 하는 법정 최소치다(사장님 지시:
    // "가깝게? 그거 안돼... 법적으로 지켜야할 사항이야") — fillCornerSlack까지 끝난 뒤 최종
    // 상태로 다시 확인해서, 그래도 안 맞는 사람이 있으면(연속근무 제한 등으로 정말 불가피한
    // 경우만 여기 남는다) 조용히 넘어가지 않고 반드시 알린다.
    let maxOff = -Infinity;
    let minOff = Infinity;
    let missedTarget = false;
    employees.forEach((emp) => {
      maxOff = Math.max(maxOff, monthOff[emp.id]);
      minOff = Math.min(minOff, monthOff[emp.id]);
      if (monthOff[emp.id] !== Math.round(target[emp.id])) missedTarget = true;
    });
    if (missedTarget) {
      conflicts.push({
        date: null,
        type: 'IMBALANCE_NOTICE',
        message: `전체 휴무일수를 목표에 정확히 맞추지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일). 연속 근무 제한 때문에 더 이상 조정할 수 없는 경우입니다.`,
        employeeIds: []
      });
    }

    return { target, personalCap };
  }

  // 파트장 backfill: for any date where a department's own dedicated staff can't meet its
  // minimum staffing (a MIN_STAFF_VIOLATION was recorded for that dept's own people), pull in
  // an available 파트장 (currently resting, not BASE/MANUAL locked) to cover the gap. This runs
  // after every department/관리 group has already been scheduled independently.
  // Scans each employee's FINAL schedule (after every rebalance/backfill pass has run) and forces
  // a rest day back in wherever their actual consecutive-WORK streak still exceeds their own
  // personalCap — a last-resort safety net, not the primary enforcement mechanism (Phase 1's
  // forcedOff and every rebalance pass's cap checks are), for whichever pass might still slip a
  // violation through despite each individually checking. The offending day (the one that first
  // pushes the streak past the cap) is converted to AUTO_FORCED OFF, unless it's BASE/MANUAL
  // locked — a locked day can't be un-locked, so that genuinely unavoidable case is only flagged.
  function enforceConsecutiveCap(schedule, employees, dates, personalCapByEmpId, conflicts) {
    employees.forEach((emp) => {
      const cap = personalCapByEmpId[emp.id];
      if (cap == null) return;
      let streak = 0;
      for (const date of dates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'WORK') {
          streak++;
          if (streak > cap) {
            if (cell.source === 'BASE' || cell.source === 'MANUAL') {
              conflicts.push({
                date,
                type: 'MIN_STAFF_VIOLATION',
                message: `${date}: ${emp.name}님이 연속 근무 제한(${cap}일)을 넘겼지만 고정/수동 근무라 조정할 수 없습니다.`,
                employeeIds: [emp.id]
              });
              continue;
            }
            setCell(schedule, emp.id, date, 'OFF', 'AUTO_FORCED');
            streak = 0;
          }
        } else {
          streak = 0;
        }
      }
    });
  }

  function backfillPartLeaders(schedule, employees, deptEmployees, deptRules, rules, dates, conflicts, targetByEmpId) {
    const partLeaders = employees.filter((emp) => Model.employeeCorners(emp).includes('파트장'));
    if (partLeaders.length === 0) return;

    // Track each leader's remaining OFF-day count (as already finalized by their own group's
    // scheduling pass) and always pull from whoever currently has the MOST rest days left when
    // a shortfall needs covering — otherwise a fixed iteration order always favors pulling the
    // same person first, unevenly stripping their target off-days over the month.
    const offRemaining = {};
    partLeaders.forEach((leader) => {
      offRemaining[leader.id] = dates.filter((d) => schedule[leader.id][d].status === 'OFF').length;
    });

    ['문구', '서적'].forEach((dept) => {
      const deptEmps = deptEmployees[dept];
      if (deptEmps.length === 0) return;
      const groupRules = Object.assign({}, rules, deptRules[dept] || {});

      dates.forEach((date) => {
        const req = Math.max(Model.minStaffRequired(groupRules, date), (groupRules.minMorningStaff || 0) + (groupRules.minAfternoonStaff || 0));
        let working = deptEmps.filter((e) => schedule[e.id][date].status === 'WORK').length;
        if (working >= req) return;

        // AUTO_FORCED is a hard consecutive-work-cap rest day, not a discretionary fairness one —
        // pulling it back to WORK would push that person past their cap, which is exactly the
        // real-world limit this exists to prevent (사장님 지시: "연속근무제한이 왜 문제라는거니 ...
        // 무조건 휴무가 먼저"). Only BASE/MANUAL were excluded before; AUTO_FORCED must be too.
        // And even among the rest: only pull someone who's currently sitting ABOVE their own
        // target off-days count — target is a legal minimum (법정 휴무: 빨간날/공휴일 + 이미 쓴
        // 연차·체단·인정), not a suggestion, so staffing a department can never be allowed to
        // shave it down. If nobody has spare days above target, this date's shortfall goes
        // unfilled and gets reported below instead.
        const availableLeaders = partLeaders
          .filter((leader) => {
            const cell = schedule[leader.id][date];
            if (cell.status !== 'OFF' || cell.source === 'BASE' || cell.source === 'MANUAL' || cell.source === 'AUTO_FORCED') return false;
            const target = targetByEmpId ? targetByEmpId[leader.id] : undefined;
            if (target != null && offRemaining[leader.id] <= target) return false;
            return true;
          })
          .sort((a, b) => offRemaining[b.id] - offRemaining[a.id]);

        for (const leader of availableLeaders) {
          if (working >= req) break;
          setCell(schedule, leader.id, date, 'WORK', 'AUTO');
          offRemaining[leader.id]--;
          working++;
        }

        if (working < req) {
          conflicts.push({
            date,
            type: 'MIN_STAFF_VIOLATION',
            message: `${date}: 파트장 투입에도 '${dept}' 최소 근무 인원(${req}명)을 채울 수 없습니다.`,
            employeeIds: []
          });
        }
      });
    });

    if (partLeaders.length > 1) {
      let maxOff = -Infinity;
      let minOff = Infinity;
      partLeaders.forEach((leader) => {
        maxOff = Math.max(maxOff, offRemaining[leader.id]);
        minOff = Math.min(minOff, offRemaining[leader.id]);
      });
      if (maxOff - minOff > 1) {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `파트장은 항상 최소 1명은 근무해야 한다는 제약과 부서 최소 인원 보충 때문에, 휴무일수를 파트장끼리 완전히 고르게 나누지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
          employeeIds: []
        });
      }
    }
  }

  // Some employees prefer the "짧은 근무" shift right at the edge of a rest day: morning shift
  // on the day right before they're off (so their afternoon is already free), and afternoon
  // shift on the day right after returning from off (a lighter re-entry than an early morning).
  // Returns -1 (wants morning), 1 (wants afternoon), or 0 (no preference / not applicable).
  function edgeShiftPreference(emp, date, dates, schedule) {
    if (!emp.edgeShiftPreference) return 0;
    const idx = dates.indexOf(date);
    const nextDate = dates[idx + 1];
    const prevDate = dates[idx - 1];
    const nextOff = nextDate && schedule[emp.id][nextDate] && schedule[emp.id][nextDate].status === 'OFF';
    const prevOff = prevDate && schedule[emp.id][prevDate] && schedule[emp.id][prevDate].status === 'OFF';
    if (nextOff && !prevOff) return -1;
    if (prevOff && !nextOff) return 1;
    return 0;
  }

  // "퐁당퐁당" 방지: 근무일이 이어질 때 전-후-전-후처럼 매일 근무조가 바뀌면 힘들다는 사장님
  // 지시 — rules.avoidAlternatingShift가 켜져 있으면 어제도 근무했던 사람은 오늘도 어제와 같은
  // 조를 우선 배정해서, 같은 조로 몰아 근무하는 흐름을 만든다. 어제 쉬었거나(연속 근무 시작일)
  // 어제 조가 안 정해졌으면 이 규칙은 관여하지 않는다.
  function shiftContinuityPreference(emp, date, dates, schedule, rules) {
    if (!rules.avoidAlternatingShift) return 0;
    const idx = dates.indexOf(date);
    const prevDate = dates[idx - 1];
    if (!prevDate) return 0;
    const prevCell = schedule[emp.id][prevDate];
    if (!prevCell || prevCell.status !== 'WORK' || !prevCell.shift) return 0;
    return prevCell.shift === 'MORNING' ? -1 : 1;
  }

  // Edge-of-rest-day preference (opt-in per employee) wins when it applies; otherwise fall back
  // to the 퐁당퐁당-avoidance continuity preference (store-wide rule) when that's enabled.
  function shiftBias(emp, date, dates, schedule, rules) {
    const edge = edgeShiftPreference(emp, date, dates, schedule);
    if (edge !== 0) return edge;
    return shiftContinuityPreference(emp, date, dates, schedule, rules);
  }

  function assignShifts(schedule, employees, dates, rules, conflicts) {
    const minMorning = rules.minMorningStaff || 0;
    const minAfternoon = rules.minAfternoonStaff || 0;
    const cornerShiftMin = rules.minStaffByCorner || {};
    const hasCornerShiftReq = Object.values(cornerShiftMin).some((req) => (req.morning || 0) > 0 || (req.afternoon || 0) > 0);
    const hasEdgePreference = employees.some((e) => e.edgeShiftPreference);
    if (minMorning === 0 && minAfternoon === 0 && !hasCornerShiftReq && !hasEdgePreference && !rules.avoidAlternatingShift && !employees.some((e) => e.shiftPreference !== 'ANY')) {
      return;
    }

    const morningCount = {};
    const afternoonCount = {};
    employees.forEach((e) => {
      morningCount[e.id] = 0;
      afternoonCount[e.id] = 0;
    });

    for (const date of dates) {
      const workingToday = employees.filter((e) => schedule[e.id][date] && schedule[e.id][date].status === 'WORK');

      const lockedMorning = [];
      const lockedAfternoon = [];
      let flexible = [];

      for (const e of workingToday) {
        const cell = schedule[e.id][date];
        if (cell.source === 'MANUAL' && cell.shift) {
          if (cell.shift === 'MORNING') lockedMorning.push(e);
          else lockedAfternoon.push(e);
        } else if (e.shiftPreference === 'MORNING') {
          lockedMorning.push(e);
        } else if (e.shiftPreference === 'AFTERNOON') {
          lockedAfternoon.push(e);
        } else {
          flexible.push(e);
        }
      }

      const byMorningNeedAsc = (a, b) =>
        (morningCount[a.id] - afternoonCount[a.id]) - (morningCount[b.id] - afternoonCount[b.id]);

      // Edge-of-rest-day preference takes priority over the plain morning/afternoon balance
      // when picking among the flexible pool (not the hard corner-minimum picks above), since
      // it's a "웬만하면" soft preference the employee opted into, not a hard requirement.
      const byMorningPreferenceThenNeed = (a, b) => {
        const prefDiff = shiftBias(a, date, dates, schedule, rules) - shiftBias(b, date, dates, schedule, rules);
        if (prefDiff !== 0) return prefDiff;
        return byMorningNeedAsc(a, b);
      };
      const byAfternoonPreferenceThenNeed = (a, b) => {
        const prefDiff = shiftBias(b, date, dates, schedule, rules) - shiftBias(a, date, dates, schedule, rules);
        if (prefDiff !== 0) return prefDiff;
        return byMorningNeedAsc(b, a);
      };

      // Corner-level minimums are satisfied first, pulling from that corner's flexible pool only
      Object.entries(cornerShiftMin).forEach(([corner, req]) => {
        let needM = req.morning || 0;
        let needA = req.afternoon || 0;
        if (needM === 0 && needA === 0) return;
        const cornerWorking = workingToday.filter((e) => Model.employeeCorners(e).includes(corner));
        const cornerLockedM = lockedMorning.filter((e) => Model.employeeCorners(e).includes(corner)).length;
        const cornerLockedA = lockedAfternoon.filter((e) => Model.employeeCorners(e).includes(corner)).length;
        const cornerFlexible = flexible.filter((e) => Model.employeeCorners(e).includes(corner));

        // 문보장은 오후에 손님이 더 많아서, 셋이 다 근무하는 날은 2명을 오후로 몰아준다
        // (기본 오전1/오후1 최소치보다 더 필요할 때만 발동 — 인원이 3명 미만이면 그대로).
        if (corner === '문보장' && cornerWorking.length >= 3) {
          needA = Math.max(needA, 2);
        }

        const remainM = Math.max(0, needM - cornerLockedM);
        const remainA = Math.max(0, needA - cornerLockedA);

        if (remainM + remainA > cornerFlexible.length) {
          conflicts.push({
            date,
            type: 'CORNER_SHIFT_MIN_VIOLATION',
            message: `${date}: '${corner}' 코너 오전/오후 최소 인원(오전 ${needM}명, 오후 ${needA}명)을 채울 인원이 부족합니다.`,
            employeeIds: cornerWorking.map((e) => e.id)
          });
        }

        // When the corner is short-handed (not enough flexible people to cover both morning
        // and afternoon minimums), afternoon takes priority — fill afternoon's need first,
        // morning gets whoever's left. This means a single available person defaults to
        // afternoon rather than morning.
        cornerFlexible.sort((a, b) => byMorningNeedAsc(b, a));
        const pickA = cornerFlexible.slice(0, remainA);
        const pickAIds = new Set(pickA.map((e) => e.id));
        const remainingCornerFlex = cornerFlexible.filter((e) => !pickAIds.has(e.id));
        remainingCornerFlex.sort(byMorningNeedAsc);
        const pickM = remainingCornerFlex.slice(0, remainM);
        const pickMIds = new Set(pickM.map((e) => e.id));

        flexible = flexible.filter((e) => !pickMIds.has(e.id) && !pickAIds.has(e.id));
        lockedMorning.push(...pickM);
        lockedAfternoon.push(...pickA);
      });

      const needMorning = Math.max(0, minMorning - lockedMorning.length);
      const needAfternoon = Math.max(0, minAfternoon - lockedAfternoon.length);

      if (needMorning + needAfternoon > flexible.length) {
        conflicts.push({
          date,
          type: 'SHIFT_MIN_VIOLATION',
          message: `${date}: 오전/오후 최소 인원(오전 ${minMorning}명, 오후 ${minAfternoon}명)을 모두 채울 인원이 부족합니다.`,
          employeeIds: workingToday.map((e) => e.id)
        });
      }

      flexible.sort(byMorningPreferenceThenNeed);
      const chosenMorning = flexible.slice(0, needMorning);
      const chosenMorningIds = new Set(chosenMorning.map((e) => e.id));
      const afterMorningPick = flexible.filter((e) => !chosenMorningIds.has(e.id));

      afterMorningPick.sort(byAfternoonPreferenceThenNeed);
      const chosenAfternoon = afterMorningPick.slice(0, needAfternoon);
      const chosenAfternoonIds = new Set(chosenAfternoon.map((e) => e.id));
      const leftover = afterMorningPick.filter((e) => !chosenAfternoonIds.has(e.id));

      let dayMorningCount = lockedMorning.length + chosenMorning.length;
      let dayAfternoonCount = lockedAfternoon.length + chosenAfternoon.length;

      leftover.sort(byMorningNeedAsc);
      for (const e of leftover) {
        const pref = shiftBias(e, date, dates, schedule, rules);
        const diff = morningCount[e.id] - afternoonCount[e.id];
        const assignMorning = pref !== 0 ? pref < 0 : (diff < 0 || (diff === 0 && dayMorningCount <= dayAfternoonCount));
        if (assignMorning) {
          chosenMorning.push(e);
          dayMorningCount++;
        } else {
          chosenAfternoon.push(e);
          dayAfternoonCount++;
        }
      }

      [...lockedMorning, ...chosenMorning].forEach((e) => {
        schedule[e.id][date].shift = 'MORNING';
      });
      [...lockedAfternoon, ...chosenAfternoon].forEach((e) => {
        schedule[e.id][date].shift = 'AFTERNOON';
      });

      for (const e of workingToday) {
        if (schedule[e.id][date].shift === 'MORNING') morningCount[e.id]++;
        else afternoonCount[e.id]++;
      }
    }
  }

  // swapDates: which dates are eligible to swap on. allDates: the full month, used to
  // correctly measure consecutive-workday streaks across day boundaries not in swapDates.
  function rebalance(schedule, employees, allEmployees, swapDates, allDates, personalCap, cornerAllowedOff, offCount, conflicts, silent) {
    if (employees.length < 2) return;
    const maxIterations = employees.length * swapDates.length * 4;
    let iterations = 0;

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = allDates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, allDates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < allDates.length && statusOn(empId, allDates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > personalCap[empId];
    }

    while (iterations < maxIterations) {
      iterations++;
      const sortedDesc = [...employees].sort((a, b) => offCount[b.id] - offCount[a.id]);
      const sortedAsc = [...employees].sort((a, b) => offCount[a.id] - offCount[b.id]);

      let swapped = false;
      outer: for (const eMax of sortedDesc) {
        for (const eMin of sortedAsc) {
          if (eMax.id === eMin.id) continue;
          if (offCount[eMax.id] - offCount[eMin.id] <= 1) break outer;

          let chosenDate = null;
          for (const date of swapDates) {
            if (
              sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
              statusOn(eMax.id, date) === 'OFF' &&
              sourceOn(eMin.id, date) === 'AUTO' &&
              statusOn(eMin.id, date) === 'WORK' &&
              !wouldExceedCap(eMax.id, date) &&
              !wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, eMin, date)
            ) {
              chosenDate = date;
              break;
            }
          }

          if (chosenDate) {
            schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
            schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
            offCount[eMax.id]--;
            offCount[eMin.id]++;
            swapped = true;
            break outer;
          }
        }
      }
      if (!swapped) break;
    }

    if (silent) return;

    let maxOff = -Infinity;
    let minOff = Infinity;
    for (const emp of employees) {
      maxOff = Math.max(maxOff, offCount[emp.id]);
      minOff = Math.min(minOff, offCount[emp.id]);
    }
    if (maxOff - minOff > 1) {
      conflicts.push({
        date: null,
        type: 'IMBALANCE_NOTICE',
        message: `평일 휴무를 완전한 균형으로 맞추지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
        employeeIds: []
      });
    }
  }

  // Decoupled final rebalance: unlike rebalance() above, the day taken from the over-target
  // person and the day given to the under-target person don't have to be the same date. This
  // closes gaps that same-date swapping can't reach. Critically, this drives everyone toward
  // their OWN target[] count, not just toward each other — mutual closeness (e.g. everyone
  // within 1 of each other) isn't the goal; hitting the actual target number is (사장님 지시:
  // 휴무 개수가 최우선이니 목표에 정확히 맞춰야 함).
  //
  // If someone still can't be brought down to target under the normal cap (their locked days
  // happen to sit such that every fairness-off day they have would create an over-cap run if
  // worked), the cap is relaxed by +1 for that one person only, as a last resort — never
  // globally, and only once every normal-cap swap has been exhausted. This is escalated up to
  // +3 before giving up, since hitting the target always outranks the consecutive-work cap.
  function rebalanceDecoupled(schedule, employees, allEmployees, dates, personalCap, cornerAllowedOff, offCount, target, conflicts, excludeDatesForSlack) {
    if (employees.length < 2) return;
    const maxIterations = employees.length * dates.length * 8;
    const maxCapBonus = 3;
    let iterations = 0;

    const capBonus = {};
    employees.forEach((e) => { capBonus[e.id] = 0; });

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCapIfWork(empId, date, bonus) {
      const idx = dates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, dates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < dates.length && statusOn(empId, dates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > personalCap[empId] + bonus;
    }
    function findReduceDate(empId, bonus) {
      for (const date of dates) {
        if (
          sourceOn(empId, date) === 'AUTO_FAIRNESS' &&
          statusOn(empId, date) === 'OFF' &&
          !wouldExceedCapIfWork(empId, date, bonus)
        ) {
          return date;
        }
      }
      return null;
    }

    while (iterations < maxIterations) {
      iterations++;
      // Over-target: currently more OFF days than their own target calls for. Under-target: fewer.
      const over = employees.filter((e) => offCount[e.id] > target[e.id]).sort((a, b) => (offCount[b.id] - target[b.id]) - (offCount[a.id] - target[a.id]));
      const under = employees.filter((e) => offCount[e.id] < target[e.id]).sort((a, b) => (target[b.id] - offCount[b.id]) - (target[a.id] - offCount[a.id]));
      if (over.length === 0 || under.length === 0) break;

      let swapped = false;
      outer: for (const eMax of over) {
        let reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        while (!reduceDate && capBonus[eMax.id] < maxCapBonus) {
          capBonus[eMax.id]++;
          reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        }
        if (!reduceDate) continue;

        for (const eMin of under) {
          if (eMin.id === eMax.id) continue;

          let increaseDate = null;
          for (const date of dates) {
            if (excludeDatesForSlack && excludeDatesForSlack.has(date)) continue;
            if (
              sourceOn(eMin.id, date) === 'AUTO' &&
              statusOn(eMin.id, date) === 'WORK' &&
              !wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, eMin, date)
            ) {
              increaseDate = date;
              break;
            }
          }
          if (!increaseDate) continue;

          schedule[eMax.id][reduceDate] = { status: 'WORK', source: 'AUTO' };
          schedule[eMin.id][increaseDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
          offCount[eMax.id]--;
          offCount[eMin.id]++;
          swapped = true;
          break outer;
        }
      }
      if (!swapped) break;
    }

    // If someone is still over target here, it's not because a swap partner couldn't be found —
    // it's because there's a genuine 1-day surplus in the total (Phase 1's daily pacing can round
    // up by one day over the month), and once everyone else sits exactly at their target there's
    // no one left "under" to hand the extra day to. A straight swap can only move the surplus
    // around, never remove it — so just drop it: convert the over-target person's rest day
    // straight to work, with no counterpart, shrinking the total by one.
    let trimIterations = 0;
    while (trimIterations < employees.length * 2) {
      trimIterations++;
      const stillOver = employees.filter((e) => offCount[e.id] > target[e.id])
        .sort((a, b) => (offCount[b.id] - target[b.id]) - (offCount[a.id] - target[a.id]));
      if (stillOver.length === 0) break;

      let trimmed = false;
      for (const eMax of stillOver) {
        let reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        while (!reduceDate && capBonus[eMax.id] < maxCapBonus) {
          capBonus[eMax.id]++;
          reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        }
        if (!reduceDate) continue;
        schedule[eMax.id][reduceDate] = { status: 'WORK', source: 'AUTO' };
        offCount[eMax.id]--;
        trimmed = true;
        break;
      }
      if (!trimmed) break;
    }

    // No conflict is logged here yet — fillCornerSlack (runGroupSchedule, right after this call)
    // can still close remaining gaps using leftover corner-cap slack, so checking "did we hit
    // target" this early would report a stale, overly pessimistic mismatch that fillCornerSlack
    // then quietly fixes. The real check happens once after that pass too.
  }

  // Spends leftover corner-cap slack (a day nobody in a capped corner is resting, even though
  // the cap would allow one more) on whoever in that corner is furthest below their OWN target —
  // target-relative, not just peer-relative, because if every member of a corner is uniformly
  // under target (e.g. all 6 people in a 3-corner group sitting at 8 with a 9-day target), a
  // purely peer-relative "even them out" check sees them as already balanced and does nothing,
  // even with plenty of unused slack sitting right there (confirmed on real data: a 6-person
  // corner group had slack on 29 of 31 days yet 4 of them stayed a day under target). Converting
  // a WORK day to OFF never violates that person's own consecutive-work cap (only the reverse
  // direction can), so no personalCap check is needed here.
  function fillCornerSlack(schedule, employees, allEmployees, dates, cornerAllowedOff, offCount, target, excludeDates) {
    const corners = Object.keys(cornerAllowedOff).filter((c) => cornerAllowedOff[c] != null);
    if (corners.length === 0) return;
    const maxIterations = employees.length * dates.length * 2;
    let iterations = 0;
    let changed = true;
    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;
      for (const corner of corners) {
        const members = employees.filter((e) => Model.employeeCorners(e).includes(corner));
        if (members.length < 2) continue;
        const underTarget = members.filter((e) => offCount[e.id] < target[e.id]);
        const candidatePool = underTarget.length > 0 ? underTarget : members;
        const sorted = [...candidatePool].sort((a, b) => offCount[a.id] - offCount[b.id]);
        const lowest = sorted[0];
        const highest = [...members].sort((a, b) => offCount[b.id] - offCount[a.id])[0];
        // Peer-relative fallback (spread > 1) only kicks in once nobody's under target anymore —
        // otherwise skip it entirely so this loop keeps lifting under-target members instead of
        // stopping the moment peers merely look "close enough" to each other.
        if (underTarget.length === 0 && offCount[highest.id] - offCount[lowest.id] <= 1) continue;
        for (const date of dates) {
          // Skip dates a sibling department is already short-staffed on — those are exactly the
          // dates backfillPartLeaders will need to pull someone from this corner back to WORK,
          // so granting rest here would just get reversed there.
          if (excludeDates && excludeDates.has(date)) continue;
          const cell = schedule[lowest.id][date];
          if (!cell || cell.status !== 'WORK' || cell.source !== 'AUTO') continue;
          if (wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, lowest, date)) continue;
          schedule[lowest.id][date] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
          offCount[lowest.id]++;
          changed = true;
          break;
        }
      }
    }
  }

  // Balances red-day (weekend/holiday) OFF within each single-corner group so members
  // take turns resting on red days roughly evenly; multi-corner/no-corner employees
  // fall back to a store-wide group.
  function rebalanceRedDays(schedule, employees, allEmployees, redDates, allDates, personalCap, cornerAllowedOff, redDayOff, conflicts) {
    if (employees.length < 2 || redDates.length === 0) return;

    const groups = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      const key = corners.length === 1 ? Model.cornerFairnessGroup(corners[0]) || '__store__' : '__store__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(emp);
    });

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = allDates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, allDates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < allDates.length && statusOn(empId, allDates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > personalCap[empId];
    }

    Object.entries(groups).forEach(([groupKey, groupEmployees]) => {
      if (groupEmployees.length < 2) return;
      const maxIterations = groupEmployees.length * redDates.length * 4;
      let iterations = 0;

      while (iterations < maxIterations) {
        iterations++;
        const sortedDesc = [...groupEmployees].sort((a, b) => redDayOff[b.id] - redDayOff[a.id]);
        const sortedAsc = [...groupEmployees].sort((a, b) => redDayOff[a.id] - redDayOff[b.id]);

        let swapped = false;
        outer: for (const eMax of sortedDesc) {
          for (const eMin of sortedAsc) {
            if (eMax.id === eMin.id) continue;
            if (redDayOff[eMax.id] - redDayOff[eMin.id] <= 1) break outer;

            let chosenDate = null;
            for (const date of redDates) {
              if (
                sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
                statusOn(eMax.id, date) === 'OFF' &&
                sourceOn(eMin.id, date) === 'AUTO' &&
                statusOn(eMin.id, date) === 'WORK' &&
                !wouldExceedCap(eMax.id, date) &&
                !wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, eMin, date)
              ) {
                chosenDate = date;
                break;
              }
            }

            if (chosenDate) {
              schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
              schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
              redDayOff[eMax.id]--;
              redDayOff[eMin.id]++;
              swapped = true;
              break outer;
            }
          }
        }
        if (!swapped) break;
      }

      let maxOff = -Infinity;
      let minOff = Infinity;
      for (const emp of groupEmployees) {
        maxOff = Math.max(maxOff, redDayOff[emp.id]);
        minOff = Math.min(minOff, redDayOff[emp.id]);
      }
      if (maxOff - minOff > 1 && groupKey !== '__store__') {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `'${groupKey}' 코너는 빨간날(주말/공휴일) 휴무를 완전히 고르게 나누지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
          employeeIds: []
        });
      }
    });
  }

  return { generateSchedule };
})();
