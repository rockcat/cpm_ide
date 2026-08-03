;==============================================================
;  FLTEST - diagnoses remotccp.asm's FL (list files) command
;==============================================================
;Standalone CP/M 2.2 diagnostic .COM - no host/serial link
;involved, just run it directly at the console, on whichever
;drive you want to test (select it first, then run FLTEST).
;
;Mirrors remotccp.asm's DO_FL/FL_ENTRY, but prints a breadcrumb
;immediately BEFORE every BDOS call that could plausibly hang
;(F_SFIRST, F_SNEXT), and the result immediately after. If FL
;genuinely hangs on a device, the program never returns to the
;CCP either way - but whatever DID get printed before it froze
;pins down exactly which call never returned, rather than just
;"FL hangs" with no more detail than that.
;
;FL_WILD here uses plain all-'?' rather than remotccp.asm's
;current '*'+'?' pattern - deliberately diverging to test it. A
;run with '*'+'?' returned F_SFIRST=FFh (no matches at all) on a
;drive known to have real files, meaning this BDOS treats '*' as
;a literal byte to match, not a wildcard. This version checks
;whether plain '?' - the standard, BDOS-level wildcard character
;- fares better.
;
;All output goes through PRNCHR (BDOS 2), one character at a
;time - never BDOS 9 (C_WRITESTR) - see drivetest.asm's PRNSTR
;for why: an unpaced burst of characters has come back garbled/
;hung on at least one piece of real hardware.
;
;A safety cap (MAXENTRIES) stops the entry-printing loop after
;too many results - that's this program protecting itself from
;a directory-corruption scenario where F_SNEXT keeps returning
;plausible-looking entries forever, not a stand-in for a genuine
;BDOS hang (which would freeze inside the F_SNEXT call itself,
;before ever reaching the cap check).
;
;Before the FL test itself, this now also replicates the exact
;sequence the real extension runs against a live REMOTCCP.COM
;session - DL (drive scan, BIOS SELDSK direct) then DS A (BDOS 14
;select), all before FL - rather than testing FL in isolation off
;a cold program start like the previous version of this file did.
;Reason: that isolated version found every file correctly, yet
;the real DL-then-FL sequence through remotccp.asm still reports
;zero files even with FL_WILD fixed. If DO_DL's direct BIOS calls
;(bypassing BDOS entirely) leave BDOS's own disk-select state
;confused in a way DS's BDOS 14 call doesn't fully repair, running
;the same sequence here should reproduce it.
;==============================================================

	org	100h

;----------------------
;BDOS entry point & functions
;----------------------
BDOS		equ	0005h

C_WRITE		equ	2	;E=char to send
DRV_SET		equ	14	;E=drive 0-15
F_SFIRST	equ	17	;DE=FCB
F_SNEXT		equ	18	;DE=FCB
DRV_GET		equ	25	;returns drive 0-15 in A
F_DMAOFF	equ	26	;DE=DMA address

CR	equ	0Dh
LF	equ	0Ah

;Offset of the SELDSK entry within the 17-entry BIOS jump table -
;see drivetest.asm/remotccp.asm for the full explanation.
SELDSK_OFS	equ	27

;200 comfortably clears real directories seen in testing (one
;had 55+ files) while still catching genuine runaway corruption;
;ENTRYCNT is a single byte, so this must stay under 256.
MAXENTRIES	equ	200	;safety cap - see header

;==============================================================
;Startup
;==============================================================
START:	ld	de,MSGHDR
	call	PRNSTR

	ld	c,DRV_GET
	call	BDOS
	add	a,'A'
	ld	de,MSG_DRV
	call	PRNSTR
	call	PRNCHR
	call	PRNCRLF

	;The warm-boot vector at 0001H points at the BIOS jump
	;table's second entry - see remotccp.asm's START for the
	;full explanation. Needed by TEST_DL below.
	ld	hl,(1)
	ld	de,3
	or	a
	sbc	hl,de
	ld	(BIOSBASE),hl

	ld	de,MSG_DL
	call	PRNSTR
	call	TEST_DL
	call	PRNCRLF

	ld	de,MSG_DS
	call	PRNSTR
	ld	e,0		;drive A
	ld	c,DRV_SET
	call	BDOS
	ld	de,MSG_OK
	call	PRNSTR

	ld	de,MSG_DMA
	call	PRNSTR
	ld	de,DMABUF
	ld	c,F_DMAOFF
	call	BDOS
	ld	de,MSG_OK
	call	PRNSTR

	ld	de,MSG_WILD
	call	PRNSTR
	call	FL_WILD
	ld	de,MSG_OK
	call	PRNSTR

	;Dump the search FCB's first 12 bytes (drive + name + ext) in
	;hex, so the exact wildcard pattern being handed to F_SFIRST
	;can be checked by eye.
	ld	de,MSG_FCB
	call	PRNSTR
	ld	hl,XFCB
	ld	b,12
DUMP_LP:	ld	a,(hl)
	call	PRNHEX
	ld	a,' '
	call	PRNCHR
	inc	hl
	djnz	DUMP_LP
	call	PRNCRLF

	xor	a
	ld	(ENTRYCNT),a

	ld	de,MSG_SFIRST
	call	PRNSTR
	ld	de,XFCB
	ld	c,F_SFIRST
	call	BDOS
	ld	(SLOT),a
	ld	de,MSG_RET
	call	PRNSTR
	call	PRNHEX
	call	PRNCRLF

	jp	FL_CHECK

FL_NEXT:	ld	de,MSG_SNEXT
	call	PRNSTR
	ld	a,(ENTRYCNT)
	call	PRNHEX
	call	PRNCRLF

	ld	de,XFCB
	ld	c,F_SNEXT
	call	BDOS
	ld	(SLOT),a
	ld	de,MSG_RET
	call	PRNSTR
	call	PRNHEX
	call	PRNCRLF

FL_CHECK:	ld	a,(SLOT)
	cp	0FFh
	jp	z,FL_DONE

	call	FL_ENTRY

	ld	a,(ENTRYCNT)
	inc	a
	ld	(ENTRYCNT),a
	cp	MAXENTRIES
	jp	nc,FL_SAFETY
	jp	FL_NEXT

FL_SAFETY:	ld	de,MSG_SAFETY
	call	PRNSTR
	jp	FL_END

FL_DONE:	ld	de,MSG_DONE
	call	PRNSTR
FL_END:	jp	0		;back to CCP (warm boot) - not a bare RET: that
					;relies on the CCP having pre-loaded the stack
					;with the warm-boot address before jumping into
					;this program, which isn't true on every BIOS
					;(observed rebooting in a loop on a Z80-MBC2
					;board otherwise) - JP 0 doesn't depend on that.

;--------------------------------------------------------------
;Replicates remotccp.asm's DO_DL exactly (BIOS SELDSK, called
;directly, for each of A-P), printing the letters it finds -
;see remotccp.asm/drivetest.asm for the full explanation of the
;technique itself. Restores the original drive afterward, same
;as DO_DL does.
;
;Scanning drive A alone (not the full A-P) previously confirmed
;F_SFIRST works fine afterward - the corruption is specifically
;caused by probing drives that don't exist (B-P), not by SELDSK
;on a real one. Back to the full A-P sweep now, but this version
;ALSO re-asserts the original drive via SELDSK itself (not just
;BDOS 14, which DO_DL already did and wasn't enough on its own)
;right before returning - testing whether that repairs whatever
;the B-P probing leaves confused for F_SFIRST afterward.
;--------------------------------------------------------------
SCANCOUNT	equ	16	;how many drives TEST_DL probes - see above

TEST_DL:	ld	c,DRV_GET
	call	BDOS
	ld	(ORIGDRV),a
	xor	a
	ld	(DRVIDX),a
TDL_LP:	ld	a,(DRVIDX)
	ld	c,a		;C = drive number for SELDSK
	ld	hl,(BIOSBASE)
	ld	de,SELDSK_OFS
	add	hl,de		;HL -> SELDSK's jump-table entry
	ld	de,0		;E=0: tell the BIOS to re-verify the media
	call	CALLHL		;-> HL = DPH address, or 0000H if no such drive
	ld	a,h
	or	l
	jp	z,TDL_NEXT
	ld	a,(DRVIDX)
	add	a,'A'
	call	PRNCHR
TDL_NEXT:	ld	a,(DRVIDX)
	inc	a
	ld	(DRVIDX),a
	cp	SCANCOUNT
	jp	c,TDL_LP

	;Re-assert the original drive via SELDSK itself before the
	;BDOS 14 restore below - see the comment above TEST_DL.
	ld	a,(ORIGDRV)
	ld	c,a
	ld	hl,(BIOSBASE)
	ld	de,SELDSK_OFS
	add	hl,de
	ld	de,0
	call	CALLHL

	ld	a,(ORIGDRV)
	ld	e,a
	ld	c,DRV_SET
	call	BDOS
	ret

;Z80 has no "CALL (HL)" opcode - see remotccp.asm's CALLHL.
CALLHL:	jp	(hl)

;--------------------------------------------------------------
;Fills XFCB with a "match everything" wildcard pattern - '?' in
;every name/extension byte. THIS variant (not remotccp.asm's
;current '*'+'?' one) is what's being tested here - see the
;file header for why: a run with the '*'+'?' pattern returned
;F_SFIRST=FFh (no matches at all) on a drive known to have real
;files, meaning this BDOS treats '*' as a literal byte to match
;rather than a wildcard, and the earlier switch away from plain
;'?' was wrong for this hardware.
;--------------------------------------------------------------
FL_WILD:	xor	a
	ld	(XFCB),a
	ld	hl,XFCB+1
	ld	b,11
	ld	a,'?'
FLW_LP:	ld	(hl),a
	inc	hl
	djnz	FLW_LP
	xor	a
	ld	(XFCB+12),a
	ret

;--------------------------------------------------------------
;A (via SLOT) = directory slot (0-3) returned by F_SFIRST/
;F_SNEXT; prints the entry at DMABUF+slot*32. Copied verbatim
;from remotccp.asm's FL_ENTRY, plus a trailing CRLF (one line
;per file here, instead of remotccp's wire-protocol framing).
;--------------------------------------------------------------
FL_ENTRY:	ld	a,(SLOT)
	add	a,a
	add	a,a
	add	a,a
	add	a,a
	add	a,a		;a = slot*32
	ld	hl,DMABUF
	ld	e,a
	ld	d,0
	add	hl,de
	push	hl
	inc	hl		;-> name field
	ld	b,8
FE_NM:	ld	a,(hl)
	and	7Fh
	call	PRNCHR
	inc	hl
	djnz	FE_NM
	ld	a,'.'
	call	PRNCHR
	ld	b,3
FE_EX:	ld	a,(hl)
	and	7Fh
	call	PRNCHR
	inc	hl
	djnz	FE_EX
	ld	a,'|'
	call	PRNCHR
	pop	hl
	ld	de,15
	add	hl,de		;-> RC field (entry+15)
	ld	a,(hl)
	call	PRNHEX
	ld	a,'|'
	call	PRNCHR
	call	PRNCRLF
	ret

;==============================================================
;Console output helpers - see drivetest.asm's PRNSTR for why
;this is per-character (BDOS 2) rather than BDOS 9.
;==============================================================

;DE -> '$'-terminated string
PRNSTR:	push	af
	push	de
PS_LP:	ld	a,(de)
	cp	'$'
	jp	z,PS_DONE
	call	PRNCHR
	inc	de
	jp	PS_LP
PS_DONE:	pop	de
	pop	af
	ret

;A = char to send
PRNCHR:	push	bc
	push	de
	push	hl
	ld	e,a
	ld	c,C_WRITE
	call	BDOS
	pop	hl
	pop	de
	pop	bc
	ret

;A = byte to print as 2 uppercase hex digits
PRNHEX:	push	af
	rrca
	rrca
	rrca
	rrca
	and	0Fh
	call	HEXDIG
	pop	af
	and	0Fh
	call	HEXDIG
	ret

;A = 0-15 -> sends the matching ASCII hex digit
HEXDIG:	cp	10
	jp	c,HXD_NUM
	add	a,'A'-10
	jp	PRNCHR
HXD_NUM:	add	a,'0'
	jp	PRNCHR

PRNCRLF:	ld	a,CR
	call	PRNCHR
	ld	a,LF
	call	PRNCHR
	ret

;==============================================================
;Data
;==============================================================
MSGHDR:		db	'FL (list files) diagnostic',CR,LF,'$'
MSG_DRV:	db	'Current drive: $'
MSG_DL:		db	'DL scan (BIOS SELDSK A-P + re-assert orig - see header): $'
MSG_DS:		db	'DS A (BDOS 14 select, matches remotccp.asm DO_DS)... $'
MSG_DMA:	db	'Setting DMA offset (F_DMAOFF)... $'
MSG_WILD:	db	'Building wildcard FCB... $'
MSG_FCB:	db	'FCB bytes 0-11: $'
MSG_SFIRST:	db	'Calling F_SFIRST...',CR,LF,'$'
MSG_SNEXT:	db	'Calling F_SNEXT, entry $'
MSG_RET:	db	'  returned: $'
MSG_OK:		db	'OK',CR,LF,'$'
MSG_DONE:	db	'Done - F_SFIRST/F_SNEXT returned FFh (no more entries)',CR,LF,'$'
MSG_SAFETY:	db	'Stopped: hit the safety cap without an FFh terminator - possible directory corruption, not a hang',CR,LF,'$'

SLOT:		ds	1
ENTRYCNT:	ds	1
ORIGDRV:	ds	1
DRVIDX:		ds	1
BIOSBASE:	ds	2
XFCB:		ds	36
DMABUF:		ds	128

	end
